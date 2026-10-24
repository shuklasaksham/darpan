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
  return { features: f, issues, ranked, score };
}

const weight = (id, issues) => (id === 'fillers' ? Math.min(15, 4 * issues.fillers.count) : PENALTY[id]);

// --- Rule-based notes ------------------------------------------------------

const NOTES = {
  no_speech: () => ({
    en: "I couldn't hear you in this take. Check nothing is covering the mic and try again.",
    hinglish: 'Is take mein awaaz nahi aayi. Dekhiye mic dhaka toh nahi hai, phir se try kijiye.',
    hi: 'इस टेक में आवाज़ नहीं आई। देखिए माइक ढका तो नहीं है, फिर से कोशिश कीजिए।',
  }),
  slow_start: ({ firstWordAt }) => ({
    en: `You started talking at ${firstWordAt.toFixed(1)} seconds. Speak the moment recording starts; the first 2 seconds decide if people stay.`,
    hinglish: `Aapne ${firstWordAt.toFixed(1)} second baad bolna shuru kiya. Recording shuru hote hi boliye, pehle 2 second mein hi log rukte hain.`,
    hi: `आपने ${firstWordAt.toFixed(1)} सेकंड बाद बोलना शुरू किया। रिकॉर्डिंग शुरू होते ही बोलिए, पहले दो सेकंड में ही लोग रुकते हैं।`,
  }),
  greeting_opener: () => ({
    en: 'Skip "hi guys". Open straight with your hook; viewers swipe away during greetings.',
    hinglish: '"Hi guys" chhodiye. Seedha hook se shuru kijiye, greeting pe log swipe kar dete hain.',
    hi: '"हाय गाइज़" छोड़िए। सीधा हुक से शुरू कीजिए, ग्रीटिंग पर लोग आगे बढ़ जाते हैं।',
  }),
  flat_voice: () => ({
    en: 'Your voice stayed flat. Punch the key words and let your energy rise and fall.',
    hinglish: 'Aawaz ek jaisi flat rahi. Important words pe zor dijiye, energy upar neeche hone dijiye.',
    hi: 'आवाज़ एक जैसी सपाट रही। ज़रूरी शब्दों पर ज़ोर दीजिए, ऊर्जा ऊपर नीचे होने दीजिए।',
  }),
  trailing_off: () => ({
    en: 'Your voice fades at the end of lines. Finish every line as strongly as you start it.',
    hinglish: 'Line ke end mein aawaz dheemi ho jaati hai. Har line utne hi zor se khatam kijiye jitne se shuru karte hain.',
    hi: 'लाइन के आख़िर में आवाज़ धीमी हो जाती है। हर लाइन उतने ही ज़ोर से ख़त्म कीजिए जितने से शुरू करते हैं।',
  }),
  looking_at_screen: ({ fraction }) => ({
    en: `You looked at the screen ${Math.round(fraction * 100)}% of the time. Glance at the line, then talk to the lens; that's eye contact for viewers.`,
    // "Aapki nazar ... thi" sidesteps gendered verbs (dekh rahe the / rahi thin).
    hinglish: `${Math.round(fraction * 100)}% time aapki nazar screen pe thi. Line dekh ke lens mein dekh kar boliye, wahi eye contact hai.`,
    hi: `ज़्यादातर समय आपकी नज़र स्क्रीन पर थी। लाइन देखकर लेंस में देखकर बोलिए, वही आई कॉन्टैक्ट है।`,
  }),
  cut_off_ending: () => ({
    en: 'Your last word got cut off. Hold still for one beat after you finish, then stop.',
    hinglish: 'Aakhri word kat gaya. Bolne ke baad ek second ruk ke recording band kijiye.',
    hi: 'आख़िरी शब्द कट गया। बोलने के बाद एक पल रुककर रिकॉर्डिंग बंद कीजिए।',
  }),
  fillers: ({ count, kinds }) => ({
    en: `You said ${kinds.map((k) => `"${k}"`).join(', ')} ${count} times. A silent pause sounds far more confident.`,
    hinglish: `Aapne ${kinds.map((k) => `"${k}"`).join(', ')} ${count} baar bola. Uski jagah chup-chaap ruk jaiye, zyada confident lagta hai.`,
    hi: `आपने ${count} बार "${kinds.join('", "')}" बोला। उसकी जगह चुपचाप रुक जाइए, ज़्यादा भरोसेमंद लगता है।`,
  }),
  over_length: ({ duration, plannedSeconds }) => ({
    en: `This ran ${Math.round(duration)}s against a planned ${Math.round(plannedSeconds)}s. Cut the extra words and keep it tight.`,
    hinglish: `Yeh ${Math.round(duration)} second chala, plan ${Math.round(plannedSeconds)} second ka tha. Extra words hataiye, tight rakhiye.`,
    hi: `यह ${Math.round(duration)} सेकंड चला, योजना ${Math.round(plannedSeconds)} सेकंड की थी। फ़ालतू शब्द हटाइए।`,
  }),
};

/** Up to three notes from the measured issues, in the creator's language. */
export function ruleNotes(analysis, language) {
  return analysis.ranked.slice(0, 3).map((id) => {
    const t = NOTES[id](analysis.issues[id]);
    const text = language === 'English' ? t.en : language === 'Hindi' ? t.hi : t.hinglish;
    return { issue: id, note: text, note_spoken: language === 'English' ? t.en : t.hi };
  });
}
