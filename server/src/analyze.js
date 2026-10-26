// Measures a take against the mistakes beginners make most, and writes
// director's notes from simple rules when Claude isn't available.

export const ISSUES = [
  'no_speech',
  'slow_start',
  'greeting_opener',
  'flat_voice',
  'trailing_off',
  'looking_at_screen',
  'cut_off_ending',
  'fillers',
  'over_length',
];

// Points off the score, and the order notes are given in.
const PENALTY = {
  no_speech: 80,
  looking_at_screen: 15,
  slow_start: 12,
  flat_voice: 12,
  cut_off_ending: 12,
  greeting_opener: 10,
  trailing_off: 10,
  over_length: 10,
  fillers: 0, // scaled by count below
};

const SLOW_START_S = 2.0;
const SPEECH_DB = -50; // loudness samples above this count as voiced
const FLAT_STD_DB = 3.5;
const TRAIL_DROP_DB = 6;
const SCREEN_DOWN = 0.45; // MediaPipe eyeLookDown blendshape
const SCREEN_FRACTION = 0.35;
const CUT_OFF_S = 0.25;

const GREETING =
  /^(hi+|hello|hey|helo|hai)\b[\s,!.]*(guys|everyone|everybody|friends|dosto|doston|all)\b|^(namaste|namaskar)\b[\s,!.]*(guys|dosto|doston|everyone|friends)?/i;
const FILLER_WORDS = new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'hmm', 'er', 'erm', 'ah', 'matlab', 'basically', 'मतलब', 'उम्म', 'अं']);
const FILLER_PHRASES = [['you', 'know'], ['i', 'mean'], ['kya', 'bolte'], ['kya', 'kehte']];

const clean = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Filler words and phrases in a transcript: [{ text, indices }]. */
export function findFillers(words) {
  const tokens = words.map((w) => clean(w.word));
  const found = [];
  tokens.forEach((t, i) => {
    if (FILLER_WORDS.has(t)) found.push({ text: t, indices: [i] });
    for (const [a, b] of FILLER_PHRASES) {
      if (t === a && tokens[i + 1] === b) found.push({ text: `${a} ${b}`, indices: [i, i + 1] });
    }
  });
  return found;
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/** Loudness samples ([seconds, dB]) between two times. */
function between(samples, from, to) {
  return samples.filter(([t]) => t >= from && t <= to).map(([, db]) => db);
}

function sentences(words) {
  const out = [];
  let current = [];
  words.forEach((w, i) => {
    current.push(w);
    const next = words[i + 1];
    const ends = /[.!?।]$/.test(w.text) || !next || next.start - w.end > 0.7;
    if (ends) {
      out.push(current);
      current = [];
    }
  });
  return out;
}

/**
 * @param words      Deepgram words: { word, text, start, end } in seconds
 * @param duration   take length in seconds
 * @param loudness   [[seconds, dB], ...] sampled on the phone while recording
 * @param gaze       [[seconds, eyeLookDown 0-1], ...] (front camera only)
 * @param plannedSeconds  the shot's planned length
 */
export function analyzeTake({ words, duration, loudness = [], gaze = [], plannedSeconds }) {
  const f = { duration, plannedSeconds, wordCount: words?.length ?? null };
  const issues = {};

  if (words == null) {
    // Not transcribed (no Deepgram key or it failed): judge sound and gaze only.
    words = [];
    f.wordCount = null;
  } else if (words.length === 0) {
    issues.no_speech = {};
  } else {
    f.firstWordAt = words[0].start;
    if (f.firstWordAt > SLOW_START_S) issues.slow_start = { firstWordAt: f.firstWordAt };

    const opener = words.slice(0, 4).map((w) => w.text).join(' ');
    f.opener = opener;
    if (GREETING.test(opener)) issues.greeting_opener = { opener };

    const last = words[words.length - 1];
    f.lastWordEnd = last.end;
    if (duration - last.end < CUT_OFF_S) issues.cut_off_ending = { lastWord: last.text };

    const fillers = findFillers(words).map((x) => x.text);
    f.fillers = fillers;
    if (fillers.length >= 2) issues.fillers = { count: fillers.length, kinds: [...new Set(fillers)] };
  }

  const voiced = loudness.filter(([, db]) => db > SPEECH_DB).map(([, db]) => db);
  f.voicedSamples = voiced.length;
  if (voiced.length >= 10) {
    f.loudnessStdDb = std(voiced);
    if (f.loudnessStdDb < FLAT_STD_DB) issues.flat_voice = { stdDb: f.loudnessStdDb };
  }

  // Trailing off: the last word of a line much quieter than the line itself.
  if (words.length && voiced.length >= 10) {
    const lines = sentences(words).filter((s) => s.length >= 3);
    const drops = lines
      .map((s) => {
        const lineDb = between(loudness, s[0].start, s[s.length - 1].end).filter((db) => db > SPEECH_DB);
        const w = s[s.length - 1];
        const endDb = between(loudness, w.start - 0.05, w.end + 0.05);
        if (lineDb.length < 3 || !endDb.length) return null;
        return mean(lineDb) - Math.max(...endDb);
      })
      .filter((d) => d != null);
    f.lineEndDropsDb = drops;
    const trailing = drops.filter((d) => d >= TRAIL_DROP_DB).length;
    if (drops.length && trailing / drops.length >= 0.5) issues.trailing_off = { lines: trailing, of: drops.length };
  }

  if (gaze.length >= 8) {
    f.screenFraction = gaze.filter(([, down]) => down > SCREEN_DOWN).length / gaze.length;
    if (f.screenFraction > SCREEN_FRACTION) issues.looking_at_screen = { fraction: f.screenFraction };
  }

  if (plannedSeconds > 0 && duration > plannedSeconds * 1.3 + 1) {
    issues.over_length = { duration, plannedSeconds };
  }

  let score = 100;
  for (const [id, detail] of Object.entries(issues)) {
    score -= id === 'fillers' ? Math.min(15, 4 * detail.count) : PENALTY[id];
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const ranked = Object.keys(issues).sort((a, b) => weight(b, issues) - weight(a, issues));
  f.breakdown = breakdown(issues, f);
  return { features: f, issues, ranked, score };
}

/**
 * The score split three ways, each out of 10: the hook (the first seconds),
 * the voice, and eye contact (null when it couldn't be measured, e.g. the back camera).
 */
export function breakdown(issues, f) {
  const clamp = (n) => Math.max(0, Math.min(10, Math.round(n)));
  if (issues.no_speech) return { hook: 0, voice: 0, eye: f.screenFraction == null ? null : clamp(10 * (1 - f.screenFraction)) };
  let hook = 10;
  if (issues.slow_start) hook -= Math.min(5, 1.5 + (issues.slow_start.firstWordAt - SLOW_START_S) * 1.5);
  if (issues.greeting_opener) hook -= 3;
  let voice = 10;
  if (issues.flat_voice) voice -= 3;
  if (issues.trailing_off) voice -= 2.5;
  if (issues.fillers) voice -= Math.min(3, issues.fillers.count * 0.8);
  if (issues.cut_off_ending) voice -= 1.5;
  if (issues.over_length) voice -= 1;
  // Eye contact: full marks up to 10% of the take looking down at the screen.
  const eye = f.screenFraction == null ? null : clamp(10 * (1 - Math.max(0, f.screenFraction - 0.1) / 0.9));
  return { hook: clamp(hook), voice: clamp(voice), eye };
}

const weight = (id, issues) => (id === 'fillers' ? Math.min(15, 4 * issues.fillers.count) : PENALTY[id]);

// --- Rule-based notes ------------------------------------------------------

// Short and casual, like a friend on set: what to do next take, not a report.
// Hindi and Hinglish use "karo" forms, which don't depend on gender.
const NOTES = {
  no_speech: () => ({
    en: "Couldn't hear you. Is the mic covered?",
    hinglish: 'Awaaz nahi aayi. Mic dhaka toh nahi?',
    hi: 'आवाज़ नहीं आई। माइक ढका तो नहीं?',
  }),
  slow_start: () => ({
    en: 'Start talking the moment you hit record.',
    hinglish: 'Record dabate hi bolna shuru karo.',
    hi: 'रिकॉर्ड दबाते ही बोलना शुरू करो।',
  }),
  greeting_opener: () => ({
    en: 'Skip "hi guys". Open with your hook.',
    hinglish: '"Hi guys" chhodo, seedha hook se shuru karo.',
    hi: '"हाय गाइज़" छोड़ो, सीधा हुक से शुरू करो।',
  }),
  flat_voice: () => ({
    en: 'A bit flat. Lean on the key words.',
    hinglish: 'Thoda flat laga. Main words pe zor do.',
    hi: 'थोड़ा सपाट लगा। ख़ास शब्दों पर ज़ोर दो।',
  }),
  trailing_off: () => ({
    en: 'Keep your voice up to the end of each line.',
    hinglish: 'Line ke end tak awaaz upar rakho.',
    hi: 'लाइन के आख़िर तक आवाज़ ऊपर रखो।',
  }),
  looking_at_screen: () => ({
    en: 'Look at the lens, not the screen.',
    hinglish: 'Screen nahi, lens mein dekho.',
    hi: 'स्क्रीन नहीं, लेंस में देखो।',
  }),
  cut_off_ending: () => ({
    en: 'Hold for a second after your last word.',
    hinglish: 'Aakhri word ke baad ek second ruko.',
    hi: 'आख़िरी शब्द के बाद एक पल रुको।',
  }),
  fillers: ({ kinds }) => ({
    en: `Drop the "${kinds[0]}". A pause sounds better.`,
    hinglish: `"${kinds[0]}" hatao, chup rehna zyada accha lagta hai.`,
    hi: `"${kinds[0]}" हटाओ, चुप रहना ज़्यादा अच्छा लगता है।`,
  }),
  over_length: ({ duration, plannedSeconds }) => ({
    en: `${Math.round(duration)}s for a ${Math.round(plannedSeconds)}s shot. Keep it tighter.`,
    hinglish: `${Math.round(plannedSeconds)} second ka shot tha, ${Math.round(duration)} chala. Thoda chhota karo.`,
    hi: `${Math.round(plannedSeconds)} सेकंड का शॉट था, ${Math.round(duration)} चला। थोड़ा छोटा करो।`,
  }),
};

/** Up to two notes from the measured issues, in the creator's language. */
export function ruleNotes(analysis, language) {
  return analysis.ranked.slice(0, 2).map((id) => {
    const t = NOTES[id](analysis.issues[id]);
    const text = language === 'English' ? t.en : language === 'Hindi' ? t.hi : t.hinglish;
    return { issue: id, note: text, note_spoken: language === 'English' ? t.en : t.hi };
  });
}
