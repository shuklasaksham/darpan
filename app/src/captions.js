// Caption lines, grouped exactly as the server burns them into the reel
// (server/src/reels.js, groupCaptionWords): keep the two in step.

const MAX_WORDS = 5;
const MAX_CHARS = 26;
const MERGE_CHARS = 38; // a lone word may make a line wrap to two
const PAUSE = 0.7; // seconds of silence that start a new line

/**
 * Groups timed words ({ caption, start, end }) into short lines: a line ends at
 * a full stop, a pause, or when it's full; a lone word joins a neighbour so
 * captions never flash one word at a time.
 */
export function groupCaptionWords(words) {
  const lines = [];
  let current = [];
  const chars = (list) => list.reduce((n, w) => n + w.caption.length + 1, 0);
  words.forEach((w, i) => {
    current.push(w);
    const next = words[i + 1];
    const breakHere =
      !next ||
      current.length >= MAX_WORDS ||
      chars(current) >= MAX_CHARS ||
      /[.!?।]$/.test(w.caption) ||
      (/,$/.test(w.caption) && current.length >= 3) ||
      next.start - w.end > PAUSE;
    if (breakHere) {
      lines.push(current);
      current = [];
    }
  });
  for (let i = 0; i < lines.length; i++) {
    if (lines.length < 2 || lines[i].length !== 1) continue;
    const prev = lines[i - 1];
    const next = lines[i + 1];
    const word = lines[i][0];
    if (prev && !/[.!?।]$/.test(prev.at(-1).caption) && chars(prev) + word.caption.length <= MERGE_CHARS && word.start - prev.at(-1).end <= PAUSE * 2) {
      prev.push(word);
    } else if (next && chars(next) + word.caption.length <= MERGE_CHARS && next[0].start - word.end <= PAUSE * 2) {
      next.unshift(word);
    } else continue;
    lines.splice(i, 1);
    i--;
  }
  return lines;
}

/**
 * A take's caption lines for the editor: each { indices, text, start, end } in
 * the take's own time, from its words (with `filler` flags), the creator's
 * edits by word index, and the trim.
 */
export function captionLines(words, edits, trim) {
  const edited = (i) => Object.hasOwn(edits, i);
  const timed = words
    .map((w, i) => ({ ...w, index: i, caption: String(edited(i) ? edits[i] : w.text).trim() }))
    .filter((w) => (edited(w.index) || !w.filler) && w.caption && w.end > trim.start && w.start < trim.end);
  return groupCaptionWords(timed).map((line, n, all) => ({
    indices: line.map((w) => w.index),
    text: line.map((w) => w.caption).join(' '),
    start: line[0].start,
    end: all[n + 1] ? all[n + 1][0].start : line.at(-1).end + 0.5,
  }));
}

/**
 * Spreads a retyped line back over its words, so caption timing stays per word:
 * one typed word per spoken word, the last one taking any extra, and words left
 * without one dropped. Returns the new edits.
 */
export function editLine(words, edits, indices, value) {
  const typed = value.trim().split(/\s+/).filter(Boolean);
  const next = { ...edits };
  indices.forEach((index, k) => {
    const text = k < indices.length - 1 ? (typed[k] ?? '') : typed.slice(k).join(' ');
    if (text === words[index].text && !words[index].filler) delete next[index];
    else next[index] = text;
  });
  return next;
}
