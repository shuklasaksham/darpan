import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
// Tried if the main model is unavailable to this API key.
const BACKUP_MODEL = process.env.CLAUDE_BACKUP_MODEL || 'claude-sonnet-5-5';
// If a safety classifier declines, the API re-runs the request on its recommended fallback model.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const client = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey, timeout: 90_000, maxRetries: 1 })
  : null;

export const claudeConfigured = Boolean(client);

const isRequestProblem = (err) =>
  err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.PermissionDeniedError;

/**
 * Calls Claude, stepping down when a request is rejected rather than failing:
 * 1. with the server-side refusal fallback (beta),
 * 2. without beta options,
 * 3. on the backup model,
 * 4. without structured output (JSON is then read from the text).
 */
async function create(params) {
  const attempts = [
    () => client.beta.messages.create({ ...params, ...FALLBACK }),
    () => client.messages.create(params),
    () => client.messages.create({ ...params, model: BACKUP_MODEL }),
    () => {
      const { format, ...rest } = params.output_config ?? {};
      return client.messages.create({ ...params, model: BACKUP_MODEL, output_config: rest });
    },
  ];
  let lastError;
  for (const [i, attempt] of attempts.entries()) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (!isRequestProblem(err)) throw err;
      // An empty credit balance fails every attempt the same way; don't keep trying.
      if (/credit balance/i.test(err.message)) {
        console.error('Claude API: the Anthropic account is out of credit (Console → Billing)');
        throw err;
      }
      console.error(`Claude attempt ${i + 1} rejected (${err.status}): ${err.message}`);
    }
  }
  throw lastError;
}

export class ClaudeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export const FRAMINGS = ['closeup', 'medium', 'waist_up', 'full_body'];
export const POSES = [
  'neutral',
  'talking_gesture',
  'pointing_side',
  'hands_on_hips',
  'arms_crossed',
  'waving',
  'holding_item',
  'seated',
];

const GENDER_RULES = {
  woman:
    'The creator is a woman. Every first-person Hindi verb must be feminine: "main bata rahi hoon", "maine try ki", "main gayi thi", "main karti hoon".',
  man: 'The creator is a man. Every first-person Hindi verb must be masculine: "main bata raha hoon", "maine try kiya", "main gaya tha", "main karta hoon".',
  prefer_not_to_say:
    'The creator prefers not to state a gender. Avoid gendered first-person Hindi verbs entirely: use "hum" forms ("aaj hum dekhenge"), imperatives ("chaliye dekhte hain"), or constructions like "mujhe pasand hai".',
};

const SCRIPT_RULES = {
  Hindi: 'Write every line in Hindi using Devanagari script.',
  Hinglish:
    'Write every line in Hinglish: conversational Hindi mixed with English, in Roman script, the way young Indian creators actually talk.',
  English:
    'Write every word in simple, natural Indian English. Do not use any Hindi or Hinglish words (no "yaar", "bas", "aaj", "dekho") and no Devanagari, even if the idea or trend notes are in Hindi or Hinglish: translate them.',
};

/** Pulls the first text block's JSON, after checking the response is usable. */
function parseJsonResponse(message) {
  if (message.stop_reason === 'refusal') throw new ClaudeError('Claude declined this request', 422);
  if (message.stop_reason === 'max_tokens') throw new ClaudeError('Claude ran out of room. Try a shorter idea.');
  const text = message.content.filter((block) => block.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {}
  // Without structured output the JSON may come wrapped in prose or a code fence.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ClaudeError('Claude returned something unexpected. Try again.');
  }
}

function wrapApiError(err) {
  if (err instanceof ClaudeError) return err;
  if (err instanceof Anthropic.RateLimitError) return new ClaudeError('Darpan is busy. Try again in a minute.', 503);
  if (err instanceof Anthropic.AuthenticationError) {
    console.error('Claude API error 401: ANTHROPIC_API_KEY is missing or invalid');
    return new ClaudeError('The script writer is unavailable right now.');
  }
  if (err instanceof Anthropic.APIError) {
    console.error(`Claude API error ${err.status}:`, err.message);
    return new ClaudeError('The script writer is unavailable right now.');
  }
  console.error('Claude request failed:', err);
  return new ClaudeError('The script writer is unavailable right now.');
}

// --- What's trending ---------------------------------------------------------

const TREND_TTL_MS = 6 * 60 * 60 * 1000;
const trendCache = new Map(); // key -> { notes, at }

/**
 * Short notes on what's working in Indian Reels for this niche right now,
 * found with Claude's web search. Cached for a few hours per niche.
 */
async function researchTrends(niche, language) {
  const key = `${niche.toLowerCase()}|${language}`;
  const cached = trendCache.get(key);
  if (cached && Date.now() - cached.at < TREND_TTL_MS) return cached.notes;

  const messages = [
    {
      role: 'user',
      content: `Search the web for what's trending on Instagram Reels and YouTube Shorts in India this week for the niche "${niche}" (audience speaks ${language}). Report in under 150 words: 3-5 trending formats, hooks, sounds or topics, each with one line on why it works. Plain text, no preamble.`,
    },
  ];
  let notes = '';
  try {
    // A long server-side search can pause; resume it a couple of times.
    for (let attempt = 0; attempt < 3; attempt++) {
      const message = await create({
        model: MODEL,
        max_tokens: 4000,
        output_config: { effort: 'low' },
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            max_uses: 2,
            user_location: { type: 'approximate', country: 'IN', timezone: 'Asia/Kolkata' },
          },
        ],
        messages,
      });
      if (message.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: message.content });
        continue;
      }
      if (message.stop_reason !== 'refusal') {
        notes = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim();
      }
      break;
    }
  } catch (err) {
    // Trends make the script better but aren't required for it.
    console.error('Trend research failed:', err.message);
  }
  if (notes) {
    trendCache.set(key, { notes, at: Date.now() });
    if (trendCache.size > 200) trendCache.delete(trendCache.keys().next().value);
  }
  return notes;
}

// --- Script and shot plan ----------------------------------------------------

const shotSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'framing', 'pose', 'line', 'direction', 'duration_seconds'],
  properties: {
    title: { type: 'string', description: 'Two to four words, e.g. "Hook" or "Dish 2: poha"' },
    framing: { type: 'string', enum: FRAMINGS },
    pose: { type: 'string', enum: POSES },
    line: { type: 'string', description: 'Exactly what the creator says to camera in this shot, the way they would actually talk' },
    direction: { type: 'string', description: 'What to do or show, said like a friend would, under 10 words' },
    duration_seconds: { type: 'number' },
  },
};

const scriptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'hook', 'trend_used', 'shots', 'background', 'lighting', 'caption', 'hashtags'],
  properties: {
    title: { type: 'string' },
    hook: { type: 'string', description: 'The idea behind the first 2 seconds' },
    trend_used: { type: 'string', description: 'Which current trend this rides, or "" if none fits' },
    shots: { type: 'array', items: shotSchema },
    background: {
      type: 'object',
      additionalProperties: false,
      required: ['suggestion', 'avoid'],
      properties: {
        suggestion: { type: 'string' },
        avoid: { type: 'array', items: { type: 'string' } },
      },
    },
    lighting: {
      type: 'object',
      additionalProperties: false,
      required: ['suggestion', 'avoid'],
      properties: {
        suggestion: { type: 'string' },
        avoid: { type: 'array', items: { type: 'string' } },
      },
    },
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
};

const SCRIPT_SYSTEM = `You write short vertical-video scripts for Darpan, an app that coaches first-time Indian creators while they shoot Reels on a phone, usually alone with the front camera.

Plan only as many shots as the idea needs: 1 for a single talk-to-camera thought, up to 6 for a list, tutorial or story. Never pad. Every shot is something one person can film alone with a phone propped up or held.

For each shot:
- line: what the creator says, short enough to read off a teleprompter in one breath per sentence. The first shot's line is the hook and must land in under 2 seconds.
- framing: closeup (face fills the frame), medium (chest up, the default for talking), waist_up (hands and props visible), full_body (outfits, dance, walking, showing a space).
- pose: the body pose that fits the moment, from the allowed list.
- direction: one practical sentence on what to do or show.

background: one specific, achievable suggestion for this niche and script using what an Indian home or street usually has (a plain wall, a bookshelf, a kitchen counter, a balcony with plants), plus a few things to avoid.
lighting: one specific suggestion for this script (for example "sit facing a window in the morning", "use a warm lamp beside the phone, not behind you"), plus a few things to avoid.

The lines, read in order, must form one complete script: hook first, then the content, and the last shot ends with a short call to action (follow, comment or save).

Keep the creator's idea exactly as they gave it; don't swap it for a different topic. Use the trend notes only where they genuinely fit.

HOW IT SHOULD SOUND (this matters more than anything else):
Write the way this person would actually say it to a friend on a video call, not the way a brand or a copywriter writes. Read every line out loud in your head; if it sounds like an ad, a LinkedIn post or a presenter, rewrite it.
- Everyday words and short sentences. Mix short and longer ones. Half-sentences are fine ("Sach bataun? Pehle main bhi yahi karti thi.").
- The hook is one specific, concrete claim, question or moment from their own life. No hype.
- One real detail beats three adjectives: a price, a time, a place, a name, a small mistake they made.
- Never use: "Hey guys", "Hi everyone", "In today's video", "Let's dive in", "without further ado", "game-changer", "unlock", "elevate", "level up", "journey", "secret sauce", "must-try", "you won't believe", "trust me", "mind-blowing", "ultimate", "hack" (unless it's literally the niche), "smash that like button". No lists of three for rhythm, no stacked exclamation marks, no emojis or hashtags in spoken lines.
- The call to action sounds like a person asking, not a template: "Try karke batana, theek laga ya nahi" rather than "Like, share and subscribe!".
- direction: how a friend holding the phone would say it, under 10 words ("Cup lens ke paas lao", "Pan ki taraf ishaara karo"). Not stage directions.
- title: what they'd call it when telling a friend, under 6 words. caption: one natural line plus at most 3 hashtags.
- background and lighting: say it plainly and briefly, like advice from a friend ("Window ke saamne baitho, subah ki light best hai").`;

const HINGLISH_WORDS =
  /\b(hai|hain|kya|nahi|nahin|aaj|mein|aur|bhi|bas|yaar|dekho|kaise|kyun|toh|wala|wali|karo|karte|karti|karta|hoon|raha|rahi|sabse|accha|chalo|dosto)\b/gi;

/** True when an "English" script contains Devanagari or several Hinglish words. */
function looksHindi(script) {
  const text = [script.title, script.hook, ...(script.shots ?? []).map((s) => `${s.line} ${s.direction}`)].join(' ');
  return /[ऀ-ॿ]/.test(text) || (text.match(HINGLISH_WORDS) ?? []).length >= 3;
}

export async function writeScript({ creator, idea, format, language }) {
  if (!client) throw new ClaudeError('The script writer is not set up yet', 503);
  const lang = SCRIPT_RULES[language] ? language : 'Hinglish';

  try {
    // Don't make the creator wait on trend research: use it if it's ready within a
    // few seconds (usually cached from the home screen's trend cards), otherwise
    // write without it while the research finishes in the background.
    const trends = await Promise.race([
      researchTrends(creator.niche, lang),
      new Promise((resolve) => setTimeout(() => resolve(''), 6000)),
    ]);
    const brief = [
      `Creator's niche: ${creator.niche}`,
      `Creator's first name: ${creator.name.split(/\s+/)[0]}`,
      idea ? `Creator's idea, in their own words: "${idea}"` : 'The creator has no specific idea yet; pick one that fits the niche and format.',
      format ? `Format: ${format}` : 'Format: choose what suits the idea.',
      `Language: ${SCRIPT_RULES[lang]}`,
      // Hindi verb gender only matters when the lines are in Hindi or Hinglish.
      lang === 'English' ? '' : (GENDER_RULES[creator.gender] ?? GENDER_RULES.prefer_not_to_say),
      trends ? `What's trending in this niche right now:\n${trends}` : 'No trend notes available.',
    ]
      .filter(Boolean)
      .join('\n\n');

    // The language rule also goes in the system prompt, where it outranks the
    // (often Hinglish) idea and trend notes in the brief.
    const system = `${SCRIPT_SYSTEM}\n\nLANGUAGE (strict): ${SCRIPT_RULES[lang]} This applies to every field: title, hook, lines, directions, background, lighting and caption.`;
    const params = {
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: scriptSchema } },
      system,
    };
    const messages = [{ role: 'user', content: brief }];
    let message = await create({ ...params, messages });
    let script = parseJsonResponse(message);
    // An "English" script that still slipped into Hindi or Hinglish gets one rewrite.
    if (lang === 'English' && looksHindi(script)) {
      message = await create({
        ...params,
        messages: [
          ...messages,
          { role: 'assistant', content: JSON.stringify(script) },
          {
            role: 'user',
            content:
              'Rewrite this exact script with every field in natural Indian English only: no Hindi or Hinglish words and no Devanagari. Same shots, same meaning.',
          },
        ],
      });
      script = parseJsonResponse(message);
    }
    script.shots = (script.shots ?? []).slice(0, 6);
    if (script.shots.length === 0) throw new ClaudeError('Claude returned an empty shot list. Try again.');
    script.language = lang;
    return { script, messageId: message.id };
  } catch (err) {
    throw wrapApiError(err);
  }
}

// --- One-frame check ---------------------------------------------------------

const verdict = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'tip', 'tip_spoken'],
  properties: {
    ok: { type: 'boolean' },
    tip: { type: 'string', description: 'If not ok: what to do, under 8 words, said like a friend ("Thoda window ki taraf ghumo"). Empty if ok.' },
    tip_spoken: { type: 'string', description: 'tip as it should be spoken aloud (see language rules)' },
  },
};

const frameSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['light', 'framing', 'clutter', 'angle', 'top_tip', 'top_tip_spoken'],
  properties: {
    light: verdict,
    framing: verdict,
    clutter: verdict,
    angle: verdict,
    top_tip: { type: 'string', description: 'The single most useful fix, or "" if everything is fine' },
    top_tip_spoken: { type: 'string', description: 'top_tip as it should be spoken aloud (see language rules)' },
  },
};

const SPOKEN_RULES = {
  Hindi: 'Write tips in Hindi (Devanagari). The *_spoken fields: the same, in Devanagari.',
  Hinglish:
    'Write tips in Hinglish (Roman script). The *_spoken fields: the same sentence written in Devanagari so a Hindi voice can read it.',
  English: 'Write tips in simple English. The *_spoken fields: the same sentence.',
};

export async function checkFrame({ imageBase64, shot, script, metrics, language }) {
  if (!client) throw new ClaudeError('Frame checks are not set up yet', 503);
  const lang = SPOKEN_RULES[language] ? language : 'Hinglish';
  try {
    const message = await create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: frameSchema } },
      system: `You are a camera coach looking at one frame from a creator's phone just before they record a vertical Reel. Judge only what you can see.
- light: is the face clearly and evenly lit? A bright wall behind someone is fine; only a window or lamp shining into the lens from behind them is backlight.
- framing: does the framing match the planned shot (${shot?.framing ?? 'medium'})?
- clutter: is the background distracting for this content?
- angle: is the phone at a flattering height (around eye level, not looking up the nose)?
Say each tip the way a friend holding the phone would: short, plain, casual ("karo", not "kijiye"). ${SPOKEN_RULES[lang]}`,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            {
              type: 'text',
              text: [
                shot ? `Planned shot: ${shot.title}. Framing: ${shot.framing}. Pose: ${shot.pose}. Direction: ${shot.direction}` : '',
                script?.background?.suggestion ? `Suggested background: ${script.background.suggestion}` : '',
                script?.lighting?.suggestion ? `Suggested lighting: ${script.lighting.suggestion}` : '',
                metrics ? `On-device readings (0-1 brightness): ${JSON.stringify(metrics)}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        },
      ],
    });
    return parseJsonResponse(message);
  } catch (err) {
    throw wrapApiError(err);
  }
}

// --- Director's notes on a take -------------------------------------------

const noteSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'note', 'note_spoken'],
  properties: {
    issue: {
      type: 'string',
      enum: [
        'no_speech',
        'slow_start',
        'greeting_opener',
        'flat_voice',
        'trailing_off',
        'looking_at_screen',
        'cut_off_ending',
        'fillers',
        'over_length',
        'other',
      ],
    },
    note: { type: 'string', description: 'What to do on the next take, under 12 words, like a friend on set' },
    note_spoken: { type: 'string', description: 'note as it should be spoken aloud (see language rules)' },
  },
};

const takeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'notes', 'praise'],
  properties: {
    score: { type: 'integer', description: '0-100' },
    notes: { type: 'array', items: noteSchema, description: 'At most 2, most important first' },
    praise: { type: 'string', description: 'One specific thing that worked, under 8 words, in the same language' },
  },
};

const TAKE_SYSTEM = `You are the art director on Darpan, coaching a first-time Indian creator between takes of a vertical Reel. Talk like a friend who knows filming, standing next to them: warm, direct, few words.

Give at most 2 notes, most important first, and only for problems the evidence supports. Prioritise the mistakes beginners miss:
- slow_start: nothing said in the first 2 seconds, or opening with "hi guys" / greetings (greeting_opener)
- flat_voice: little variation in loudness; trailing_off: the voice drops at the end of lines
- looking_at_screen: eyes on the phone screen instead of the lens (the front camera sits above the screen, so eyes aimed slightly down in the frames means screen)
- cut_off_ending: the last word clipped by stopping too soon
- fillers: "umm", "uh", "matlab", "basically", "you know"
- over_length: well over the planned length
Use "other" only for something clearly more important than all of these. A good take can have zero or one note.

Each note is one short instruction for the next take, under 12 words. Say what to do, not a report of what went wrong ("Lens mein dekho, screen mein nahi", not "You were looking at the screen 40% of the time, which reduces eye contact"). No numbers unless they help, no jargon ("engagement", "retention", "delivery"), no filler praise like "Great job!". Use casual, gender-neutral Hindi forms: "karo", "dekho", "ruko" (never "kar rahe the" / "kar rahi thi").
praise: one specific thing that worked, under 8 words ("Hook ekdum seedha tha"). Leave it empty rather than generic.
The on-device measurements and the rule-based findings are evidence, not orders: the frames and transcript can overrule them. Start from the rule score and adjust by at most 15 points.`;

export async function directorNotes({ shot, transcript, words, analysis, frames, language }) {
  if (!client) throw new ClaudeError('Director notes are not set up', 503);
  const lang = SPOKEN_RULES[language] ? language : 'Hinglish';
  const timed = words.map((w) => `${w.start.toFixed(2)} ${w.text}`).join(' | ');
  try {
    const message = await create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: takeSchema } },
      system: `${TAKE_SYSTEM}\n\nLanguage: ${SPOKEN_RULES[lang]}`,
      messages: [
        {
          role: 'user',
          content: [
            ...frames.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
            {
              type: 'text',
              text: [
                frames.length ? `The ${frames.length} images are frames from the start, middle and end of the take.` : 'No frames.',
                shot ? `Planned shot: ${shot.title} (${shot.framing}), planned ${shot.duration_seconds}s. Planned line: "${shot.line}"` : '',
                `Transcript (filler words kept): "${transcript}"`,
                `Word start times (s): ${timed || 'none'}`,
                `Measurements: ${JSON.stringify(analysis.features)}`,
                `Rule-based findings: ${JSON.stringify(analysis.issues)}`,
                `Rule score: ${analysis.score}`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        },
      ],
    });
    const result = parseJsonResponse(message);
    result.notes = (result.notes ?? []).slice(0, 2);
    result.score = Math.max(0, Math.min(100, Math.round(result.score)));
    return result;
  } catch (err) {
    throw wrapApiError(err);
  }
}

// --- Hinglish captions -----------------------------------------------------

const captionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['takes'],
  properties: {
    takes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['words'],
        properties: { words: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
};

/**
 * Roman-script Hinglish spellings for transcript words, one output word per
 * input word, so caption timing stays exact. Returns an array per take (null
 * where Claude's answer didn't line up, so the caller can fall back).
 */
export async function hinglishCaptions(takes) {
  if (!client) throw new ClaudeError('Captions are not set up', 503);
  try {
    const message = await create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: captionSchema } },
      system: `You write on-screen captions for Indian Reels in Hinglish: Hindi and English in Roman script, spelled the way young Indians type ("main", "nahi", "bahut", "kya", "hai"). For each take you get its words in order; return exactly one caption word for each input word, in the same order. Convert Devanagari to Roman Hinglish, keep English words as they are, keep numbers and the punctuation attached to a word. Never merge, split, drop or add words.`,
      messages: [{ role: 'user', content: JSON.stringify({ takes: takes.map((words) => ({ words })) }) }],
    });
    const result = parseJsonResponse(message);
    return takes.map((words, i) => {
      const out = result.takes?.[i]?.words;
      return Array.isArray(out) && out.length === words.length ? out : null;
    });
  } catch (err) {
    throw wrapApiError(err);
  }
}

// --- Trend cards for the home screen ----------------------------------------

const cardCache = new Map(); // niche|language -> { cards, at }

const cardsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why', 'format'],
        properties: {
          title: { type: 'string', description: 'A ready-to-shoot reel idea in under 8 words, in the requested language' },
          why: { type: 'string', description: 'One short line on why it works right now' },
          format: {
            type: 'string',
            enum: ['Talk to camera', 'Top 3 list', 'Day in my life', 'Quick how-to', 'Before → after', 'POV skit', 'Honest review', 'Storytime'],
          },
        },
      },
    },
  },
};

/** 4-6 reel ideas riding what's trending in the creator's niche. */
export async function trendCards({ niche, language }) {
  if (!client) throw new ClaudeError('Trends are not set up', 503);
  const lang = SCRIPT_RULES[language] ? language : 'Hinglish';
  const key = `${niche.toLowerCase()}|${lang}`;
  const cached = cardCache.get(key);
  if (cached && Date.now() - cached.at < TREND_TTL_MS) return cached.cards;
  try {
    const notes = await researchTrends(niche, lang);
    const message = await create({
      model: MODEL,
      max_tokens: 3000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: cardsSchema } },
      system: `You suggest reel ideas for a first-time Indian creator who films alone on a phone. Give 4 to 6 specific, doable ideas for their niche that ride what's trending now. Write each title the way a creator would describe the idea to a friend (under 8 words, no hype words like "ultimate", "hack", "game-changer"), and each "why" in one short plain line. ${SCRIPT_RULES[lang]}`,
      messages: [
        {
          role: 'user',
          content: `Niche: ${niche}\n\n${notes ? `What's trending this week:\n${notes}` : 'No trend notes available; use what generally works for this niche in India.'}`,
        },
      ],
    });
    const cards = (parseJsonResponse(message).cards ?? []).slice(0, 6);
    cardCache.set(key, { cards, at: Date.now() });
    if (cardCache.size > 200) cardCache.delete(cardCache.keys().next().value);
    return cards;
  } catch (err) {
    throw wrapApiError(err);
  }
}
