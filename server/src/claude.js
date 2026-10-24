import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const MODEL = 'claude-opus-5-5';
// If a safety classifier declines, the API re-runs the request on its recommended fallback model.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const client = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey, timeout: 90_000, maxRetries: 1 })
  : null;

export const claudeConfigured = Boolean(client);

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
  English: 'Write every line in simple Indian English.',
};

/** Pulls the first text block's JSON, after checking the response is usable. */
function parseJsonResponse(message) {
  if (message.stop_reason === 'refusal') throw new ClaudeError('Claude declined this request', 422);
  if (message.stop_reason === 'max_tokens') throw new ClaudeError('Claude ran out of room. Try a shorter idea.');
  const text = message.content.find((block) => block.type === 'text')?.text;
  try {
    return JSON.parse(text);
  } catch {
    throw new ClaudeError('Claude returned something unexpected. Try again.');
  }
}

function wrapApiError(err) {
  if (err instanceof ClaudeError) return err;
  if (err instanceof Anthropic.RateLimitError) return new ClaudeError('Darpan is busy. Try again in a minute.', 503);
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
      const message = await client.beta.messages.create({
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
        ...FALLBACK,
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
    line: { type: 'string', description: 'Exactly what the creator says to camera in this shot' },
    direction: { type: 'string', description: 'One short sentence on what to do or show' },
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

Keep the creator's idea exactly as they gave it; don't swap it for a different topic. Use the trend notes only where they genuinely fit.`;

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
      GENDER_RULES[creator.gender] ?? GENDER_RULES.prefer_not_to_say,
      trends ? `What's trending in this niche right now:\n${trends}` : 'No trend notes available.',
    ].join('\n\n');

    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: scriptSchema } },
      system: SCRIPT_SYSTEM,
      messages: [{ role: 'user', content: brief }],
      ...FALLBACK,
    });
    const script = parseJsonResponse(message);
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
    tip: { type: 'string', description: 'If not ok: one short instruction, under 10 words. Empty if ok.' },
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
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: frameSchema } },
      system: `You are a camera coach looking at one frame from a creator's phone just before they record a vertical Reel. Judge only what you can see.
- light: is the face clearly and evenly lit? A bright wall behind someone is fine; only a window or lamp shining into the lens from behind them is backlight.
- framing: does the framing match the planned shot (${shot?.framing ?? 'medium'})?
- clutter: is the background distracting for this content?
- angle: is the phone at a flattering height (around eye level, not looking up the nose)?
Be encouraging and practical. ${SPOKEN_RULES[lang]}`,
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
      ...FALLBACK,
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
    note: { type: 'string', description: 'One or two short sentences: what happened, then exactly what to do next take' },
    note_spoken: { type: 'string', description: 'note as it should be spoken aloud (see language rules)' },
  },
};

const takeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'notes', 'praise'],
  properties: {
    score: { type: 'integer', description: '0-100' },
    notes: { type: 'array', items: noteSchema, description: 'At most 3, most important first' },
    praise: { type: 'string', description: 'One specific thing that worked, in the same language' },
  },
};

const TAKE_SYSTEM = `You are the art director on Darpan, coaching a first-time Indian creator between takes of a vertical Reel. Be warm, specific and brief, like a good director on set.

Give at most 3 notes, most important first, and only for problems the evidence supports. Prioritise the mistakes beginners miss:
- slow_start: nothing said in the first 2 seconds, or opening with "hi guys" / greetings (greeting_opener)
- flat_voice: little variation in loudness; trailing_off: the voice drops at the end of lines
- looking_at_screen: eyes on the phone screen instead of the lens (the front camera sits above the screen, so eyes aimed slightly down in the frames means screen)
- cut_off_ending: the last word clipped by stopping too soon
- fillers: "umm", "uh", "matlab", "basically", "you know"
- over_length: well over the planned length
Use "other" only for something clearly more important than all of these. A good take can have zero or one note.

Each note says what happened and exactly what to do on the next take, in second person, using gender-neutral Hindi forms ("kijiye", "aapki awaaz", never "aap kar rahe/rahi the").
The on-device measurements and the rule-based findings are evidence, not orders: the frames and transcript can overrule them. Start from the rule score and adjust by at most 15 points.`;

export async function directorNotes({ shot, transcript, words, analysis, frames, language }) {
  if (!client) throw new ClaudeError('Director notes are not set up', 503);
  const lang = SPOKEN_RULES[language] ? language : 'Hinglish';
  const timed = words.map((w) => `${w.start.toFixed(2)} ${w.text}`).join(' | ');
  try {
    const message = await client.beta.messages.create({
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
      ...FALLBACK,
    });
    const result = parseJsonResponse(message);
    result.notes = (result.notes ?? []).slice(0, 3);
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
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: captionSchema } },
      system: `You write on-screen captions for Indian Reels in Hinglish: Hindi and English in Roman script, spelled the way young Indians type ("main", "nahi", "bahut", "kya", "hai"). For each take you get its words in order; return exactly one caption word for each input word, in the same order. Convert Devanagari to Roman Hinglish, keep English words as they are, keep numbers and the punctuation attached to a word. Never merge, split, drop or add words.`,
      messages: [{ role: 'user', content: JSON.stringify({ takes: takes.map((words) => ({ words })) }) }],
      ...FALLBACK,
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
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 3000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: cardsSchema } },
      system: `You suggest reel ideas for a first-time Indian creator who films alone on a phone. Give 4 to 6 specific, doable ideas for their niche that ride what's trending now. ${SCRIPT_RULES[lang]}`,
      messages: [
        {
          role: 'user',
          content: `Niche: ${niche}\n\n${notes ? `What's trending this week:\n${notes}` : 'No trend notes available; use what generally works for this niche in India.'}`,
        },
      ],
      ...FALLBACK,
    });
    const cards = (parseJsonResponse(message).cards ?? []).slice(0, 6);
    cardCache.set(key, { cards, at: Date.now() });
    if (cardCache.size > 200) cardCache.delete(cardCache.keys().next().value);
    return cards;
  } catch (err) {
    throw wrapApiError(err);
  }
}
