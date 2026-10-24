import { randomInt } from 'node:crypto';

// 3–20 lowercase letters, digits, dots or underscores; no leading, trailing or doubled dots/underscores.
export const USERNAME_PATTERN = /^(?![._])(?!.*[._]{2})[a-z0-9._]{3,20}(?<![._])$/;

// --- Devanagari → Latin, tuned for how Indian names are usually spelled in English ---

const CONSONANTS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y',
};
// Consonant + nukta written as two code points.
const NUKTA_FORMS = { 'क': 'q', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f', 'य': 'y' };
const VOWELS = {
  'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o',
};
const MATRAS = {
  'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'u', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o',
};
const VIRAMA = '्';
const NUKTA = '़';
const NASALS = new Set(['ं', 'ँ']);
const VISARGA = 'ः';

/**
 * Transliterates one Devanagari word, dropping the inherent "a" where Hindi
 * speakers drop it (कमला → kamla, संजय → sanjay, अर्जुन → arjun).
 */
function transliterateWord(word) {
  const chars = [...word];
  // Each syllable: { onset: consonant cluster, vowel, inherent: bool, coda: string }
  const syllables = [];
  let onset = '';

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (CONSONANTS[ch] !== undefined) {
      let latin = chars[i + 1] === NUKTA ? NUKTA_FORMS[ch] ?? CONSONANTS[ch] : CONSONANTS[ch];
      if (chars[i + 1] === NUKTA) i++;
      if (ch === 'ज' && chars[i + 1] === VIRAMA && chars[i + 2] === 'ञ') {
        latin = 'gy'; // ज्ञ, as in Gyan
        i += 2;
      }
      if (chars[i + 1] === VIRAMA) {
        onset += latin;
        i++;
        continue;
      }
      const matra = MATRAS[chars[i + 1]];
      if (matra !== undefined) i++;
      syllables.push({ onset: onset + latin, vowel: matra ?? 'a', inherent: matra === undefined, coda: '' });
      onset = '';
    } else if (VOWELS[ch] !== undefined) {
      syllables.push({ onset, vowel: VOWELS[ch], inherent: false, coda: '' });
      onset = '';
    } else if (NASALS.has(ch) || ch === VISARGA) {
      const last = syllables.at(-1);
      if (last) last.coda += ch === VISARGA ? 'h' : 'n';
    }
  }
  if (onset) syllables.push({ onset, vowel: '', inherent: false, coda: '' });

  // Schwa deletion, right to left: drop a word-final inherent "a", and a medial
  // one that sits between a vowel and a consonant + vowel.
  for (let i = syllables.length - 1; i > 0; i--) {
    const s = syllables[i];
    if (!s.inherent || s.coda) continue;
    const isLast = i === syllables.length - 1;
    const next = syllables[i + 1];
    const prev = syllables[i - 1];
    if (isLast || (prev.vowel && next?.vowel && next.onset)) s.vowel = '';
  }

  let out = '';
  syllables.forEach((s, i) => {
    let vowel = s.vowel;
    // "ee" reads naturally mid-name (Deepak) but "i" at the end (Lakshmi).
    if (vowel === 'ee' && i === syllables.length - 1) vowel = 'i';
    let coda = s.coda;
    // Anusvara sounds like "m" before p/b/m (शंभु → shambhu).
    const next = syllables[i + 1];
    if (coda.startsWith('n') && /^[pbm]/.test(next?.onset ?? '')) coda = 'm' + coda.slice(1);
    // ...and "ng" before a final ह (सिंह → singh).
    if (coda === 'n' && next?.onset === 'h' && !next.vowel && i + 2 === syllables.length) coda = 'ng';
    out += s.onset + vowel + coda;
  });
  return out;
}

/** Turns a name in Latin or Devanagari script into lowercase a–z words. */
export function nameToWords(name) {
  return name
    .normalize('NFC')
    .split(/[\s\-.,_]+/)
    .map((word) => (/[ऀ-ॿ]/.test(word) ? transliterateWord(word) : word))
    .map((word) => word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, ''))
    .filter(Boolean);
}

/** Candidate usernames, best first. The caller filters out ones already taken. */
export function suggestUsernames(name) {
  const words = nameToWords(name);
  const first = words[0] || 'creator';
  const last = words.length > 1 ? words.at(-1) : '';
  const digits = () => String(randomInt(10, 1000));

  const candidates = last
    ? [
        `${first}.${last}`,
        `${first}${last}`,
        `${first}_${last}`,
        `${last}.${first}`,
        `${first}${last[0]}`,
        `${first}.reels`,
        `its.${first}`,
        `${first}.creates`,
        `${first}.${last}${digits()}`,
        `${first}${digits()}`,
      ]
    : [
        first,
        `${first}.reels`,
        `its.${first}`,
        `${first}.creates`,
        `the.${first}`,
        `${first}${digits()}`,
        `${first}.${digits()}`,
        `${first}_${digits()}`,
      ];

  const seen = new Set();
  return candidates
    .map((c) => c.slice(0, 20).replace(/[._]+$/, ''))
    .filter((c) => USERNAME_PATTERN.test(c) && !seen.has(c) && seen.add(c));
}
