import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { config } from './config.js';
import { pool } from './db.js';
import { findFillers } from './analyze.js';
import { transliterateWord } from './usernames.js';

// Builds a reel from kept takes:
//   1. each take becomes a "piece": trimmed to its speech, cropped and scaled to
//      the reel size, captions and the "Shot with darpan" tag burned in (one
//      encode per take, all with identical settings), then
//   2. the pieces are joined with ffmpeg's concat demuxer without re-encoding.
// Pieces are cached next to the take and made in the background as soon as a
// take is kept or edited, so "Make my reel" usually only has to join them.
// ffmpeg runs one job at a time by default (the server has little memory); the
// creator's own reel always goes ahead of background work.

export const takesDir = path.join(config.uploadDir, 'takes');
export const reelsDir = path.join(config.uploadDir, 'reels');
fs.mkdirSync(takesDir, { recursive: true });
fs.mkdirSync(reelsDir, { recursive: true });

// Mukta (the app's own type) has Latin and Devanagari, so Hindi captions render too.
const FONT_DIR = path.join(import.meta.dirname, '..', 'fonts');
const FONT = 'Mukta';
// The "Shot with darpan" pill (from the Figma design), laid over the bottom-right corner.
const TAG_IMAGE = path.join(import.meta.dirname, '..', 'assets', 'tag.png');
const LEAD_IN = 0.15; // seconds kept before the first word
const TAIL = 0.4; // and after the last, so nothing sounds clipped
const FPS = 30;
const PIECE_VERSION = 6; // bump when the encode settings change, so old pieces aren't reused

// x264 "veryfast" at CRF 21 looks close to the phone's own recording; the
// maxrate keeps files small enough to download quickly on mobile data.
const PRESET = process.env.REEL_PRESET || 'veryfast';
const THREADS = String(Math.max(1, Number(process.env.FFMPEG_THREADS) || 1));
const CONCURRENCY = Math.max(1, Number(process.env.REEL_CONCURRENCY) || 1);

// --- Work queue --------------------------------------------------------------

const lanes = { high: [], low: [] };
let running = 0;

/** Runs `fn` when a slot is free; 'high' work (a creator waiting) goes first. */
function schedule(fn, priority = 'low') {
  const task = { fn, priority };
  task.promise = new Promise((resolve, reject) => Object.assign(task, { resolve, reject }));
  lanes[priority].push(task);
  pump();
  return task;
}

function pump() {
  while (running < CONCURRENCY) {
    const task = lanes.high.shift() ?? lanes.low.shift();
    if (!task) return;
    running++;
    task.started = true;
    task
      .fn()
      .then(task.resolve, task.reject)
      .finally(() => {
        running--;
        pump();
      });
  }
}

/** Moves waiting background work to the front when a creator now needs it. */
function promote(task) {
  if (task.started || task.priority === 'high') return;
  const i = lanes.low.indexOf(task);
  if (i >= 0) lanes.low.splice(i, 1);
  task.priority = 'high';
  lanes.high.unshift(task);
}

// --- Reel jobs ---------------------------------------------------------------

const jobs = new Map(); // reelId -> { status, progress, stage, error }

export function jobStatus(reelId) {
  return jobs.get(String(reelId)) ?? null;
}

export function enqueueReel(reel) {
  const job = { status: 'queued', progress: 0, stage: 'Getting your shots ready' };
  jobs.set(String(reel.id), job);
  buildReel(reel, job).catch(() => {});
  return job;
}

/** Deletes take and reel files older than a day (the disk is ephemeral anyway). */
export async function sweepOldFiles(maxAgeMs = 24 * 60 * 60 * 1000) {
  for (const dir of [takesDir, reelsDir]) {
    for (const name of await fs.promises.readdir(dir).catch(() => [])) {
      const file = path.join(dir, name);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > maxAgeMs) await fs.promises.rm(file, { recursive: true, force: true });
    }
  }
}

// --- Planning --------------------------------------------------------------

/**
 * Where to cut a take: where the creator trimmed it, or else from just before
 * the first word to just after the last.
 */
export function trimFor(take) {
  const words = take.words ?? [];
  const duration = take.duration_seconds ?? 0;
  if (take.trim_start != null && take.trim_end != null) {
    const start = Math.max(0, take.trim_start);
    const end = Math.min(duration || Infinity, take.trim_end);
    if (end - start >= 0.5) return { start, end };
  }
  if (!words.length) return { start: 0, end: duration };
  const start = Math.max(0, words[0].start - LEAD_IN);
  const end = Math.min(duration || Infinity, words[words.length - 1].end + TAIL);
  return end - start > 0.5 ? { start, end } : { start: 0, end: duration };
}

/** The aspect ratio the creator shot a take in (the camera records the full frame). */
export function takeAspect(take) {
  if (take.aspect > 0) return take.aspect;
  if (take.width && take.height) return take.width / take.height;
  return 9 / 16;
}

/**
 * The reel's frame for an aspect ratio, fixed per plan so pieces can be made
 * ahead of time: 9:16 is 1080×1920, 4:5 1080×1350,
 * 1:1 1080×1080, 16:9 1920×1080. Dimensions are even, as H.264 needs.
 */
export function reelSize(aspect, maxLongEdge = 1920) {
  const short = (maxLongEdge * 9) / 16;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return aspect < 1 ? { width: even(short), height: even(short / aspect) } : { width: even(short * aspect), height: even(short) };
}

/**
 * The reel's frame for a take: the camera's own resolution once cropped to the
 * reel's shape, never below 1080p and never above `maxLongEdge` (4K). A 4K
 * phone gives a 2160×3840 reel; a 1080p camera gives 1080×1920 as before.
 */
export function reelSizeFor(take, maxLongEdge = 3840) {
  const aspect = takeAspect(take);
  const w = Number(take.width) || 0;
  const h = Number(take.height) || 0;
  // The short edge of the camera image after cropping it to the reel's shape.
  const cropShort = w && h ? (w / h > aspect ? Math.min(h * aspect, h) : Math.min(w, w / aspect)) : 0;
  const short = Math.min((maxLongEdge * 9) / 16, Math.max(1080, cropShort));
  return reelSize(aspect, (short * 16) / 9);
}

/** Peak bitrate in kbit/s: Instagram's ~6 Mbps at 1080p, scaled by pixel count (about 20 Mbps at 4K). */
const maxrateFor = (width, height) => Math.round(Math.min(24000, Math.max(3500, (6000 * width * height) / (1080 * 1920))));

/**
 * Caption lines for one take: filler words dropped, spelled for the script's
 * language (see captionWord), grouped into short chunks timed to the speech. `edits` holds
 * the creator's fixes by word index; an empty string drops the word, and an
 * edited filler is kept.
 */
export function captionChunks(words, spelled, trim, edits = null, language = 'Hinglish') {
  const skip = new Set(findFillers(words).flatMap((f) => f.indices));
  const edited = (i) => edits && Object.hasOwn(edits, i);
  const kept = words
    .map((w, i) => ({ ...w, caption: (edited(i) ? String(edits[i]) : (spelled?.[i] ?? captionWord(w.text, language))).trim() }))
    .filter((w, i) => (edited(i) || !skip.has(i)) && w.caption && w.end > trim.start && w.start < trim.end);

  const chunks = groupCaptionWords(kept);
  return chunks.map((c, i) => {
    const next = chunks[i + 1];
    const start = Math.max(0, c[0].start - trim.start);
    const end = Math.min(trim.end - trim.start, next ? next[0].start - trim.start : c[c.length - 1].end - trim.start + 0.5);
    return { start, end: Math.max(end, start + 0.3), text: c.map((w) => w.caption).join(' ') };
  });
}

// Caption lines are grouped the same way in the reel editor (app/src/captions.js): keep the two in step.
const MAX_WORDS = 5;
const MAX_CHARS = 26;
const MERGE_CHARS = 38; // a lone word may make a line wrap to two
const PAUSE = 0.7; // seconds of silence that start a new line

/**
 * Groups timed words ({ caption, start, end }) into short lines: a line ends at
 * a full stop, a pause, or when it's full; a lone word joins a neighbour so
 * captions never flash one word at a time.
 */
function groupCaptionWords(words) {
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

// How everyday Hindi words are usually typed in Hinglish; the letter-by-letter
// transliteration (tuned for names) gets these wrong ("aj", "hun", "men").
const COMMON = Object.fromEntries(Object.entries({
  'आज': 'aaj', 'हूँ': 'hoon', 'हूं': 'hoon', 'में': 'mein', 'मैं': 'main', 'नहीं': 'nahi',
  'है': 'hai', 'हैं': 'hain', 'हो': 'ho', 'क्या': 'kya', 'बहुत': 'bahut', 'और': 'aur', 'यह': 'yeh',
  'ये': 'ye', 'वह': 'woh', 'वो': 'wo', 'की': 'ki', 'कि': 'ki', 'के': 'ke', 'का': 'ka', 'को': 'ko',
  'से': 'se', 'पर': 'par', 'भी': 'bhi', 'तो': 'toh', 'ही': 'hi', 'था': 'tha', 'थी': 'thi', 'थे': 'the',
  'अच्छा': 'accha', 'अच्छी': 'acchi', 'सब': 'sab', 'कुछ': 'kuch', 'आप': 'aap', 'हम': 'hum', 'तुम': 'tum',
  'अब': 'ab', 'यहाँ': 'yahan', 'वहाँ': 'wahan', 'कैसे': 'kaise', 'क्यों': 'kyun', 'सबसे': 'sabse',
  'लिए': 'liye', 'एक': 'ek', 'दो': 'do', 'तीन': 'teen', 'चार': 'chaar', 'पाँच': 'paanch', 'रुपये': 'rupaye',
  'रुपए': 'rupaye', 'चलो': 'chalo', 'चलिए': 'chaliye', 'देखो': 'dekho', 'देखिए': 'dekhiye', 'मेरा': 'mera',
  'मेरी': 'meri', 'मेरे': 'mere', 'आपका': 'aapka', 'आपकी': 'aapki', 'सिर्फ़': 'sirf', 'सिर्फ': 'sirf',
}).map(([k, v]) => [k.normalize('NFC'), v]));

/**
 * A transcript word as a caption, before (or without) Claude's spelling: Hindi
 * scripts keep what was heard, Hinglish and English ones are written in Roman letters.
 */
export const captionWord = (text, language) => (language === 'Hindi' ? text : toHinglish(text));

/** Roman-script Hinglish for a word that may be in Devanagari. */
export function toHinglish(text) {
  return text
    .replace(/[ऀ-ॣ०-ॿ]+/g, (run) => {
      const word = run.replace(/[।॥]/g, '').normalize('NFC');
      return COMMON[word] ?? transliterateWord(word);
    })
    .replace(/[।॥]/g, '.');
}

const assTime = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assText = (t) => t.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, ' ');

// How long the hook text stays up at the start of the reel.
const HOOK_SECONDS = 2.2;

/**
 * Subtitle file with the captions (lower middle, above Reels' own UI) and, on
 * the reel's first shot, the hook: big ink-on-white text in the top third
 * for the first two seconds, the way most Reels open.
 */
export function assFile({ width, height, duration, chunks, hook = null }) {
  const size = Math.round(height * 0.042);
  const hookSize = Math.round(height * 0.054);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${FONT},${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size * 0.09))},${Math.round(size * 0.04)},2,${Math.round(width * 0.08)},${Math.round(width * 0.08)},${Math.round(height * 0.3)},1
Style: Hook,${FONT},${hookSize},&H000A0A0A,&H000000FF,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,${Math.round(hookSize * 0.28)},0,8,${Math.round(width * 0.1)},${Math.round(width * 0.1)},${Math.round(height * 0.17)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${hook ? `Dialogue: 2,${assTime(0)},${assTime(Math.min(HOOK_SECONDS, duration))},Hook,,0,0,0,,{\\fad(0,250)}${assText(hook)}\n` : ''}${chunks.map((c) => `Dialogue: 1,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${assText(c.text)}`).join('\n')}
`;
}

// --- Running ffmpeg --------------------------------------------------------

/** Runs ffmpeg, reporting progress (0-1) from its -progress output. */
function ffmpeg(args, { duration, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...args]);
    // Below the web server, so requests (and Render's health check) stay quick.
    try {
      os.setPriority(child.pid, 10);
    } catch {}
    let stderr = '';
    child.stdout.on('data', (buf) => {
      const m = /out_time_us=(\d+)/.exec(buf.toString());
      if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
    });
    child.stderr.on('data', (buf) => {
      stderr = (stderr + buf.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
  });
}

const filterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
const exists = (p) => (p ? fs.promises.access(p).then(() => true, () => false) : Promise.resolve(false));

// Phone audio, cleaned: rumble below 80 Hz cut, steady background noise (fans,
// hum, traffic) reduced, and the voice brought to Instagram's loudness.
const AUDIO_CLEANUP = 'highpass=f=80,afftdn=nf=-25:tn=1,loudnorm=I=-14:TP=-1.5:LRA=11';

/** A piece is a whole number of frames long, and its sound exactly as long. */
const pieceFrames = (trim) => Math.max(1, Math.round((trim.end - trim.start) * FPS));
const pieceSamples = (trim) => Math.round((pieceFrames(trim) / FPS) * 48000);

async function encodePiece({ take, trim, size, assPath, tag, out, onProgress }) {
  const duration = trim.end - trim.start;
  const { width, height } = size;
  // The piece is a whole number of frames, and its sound exactly that long, so
  // joined pieces never drift: a phone's sound often starts late or ends early.
  const frames = pieceFrames(trim);
  const samples = pieceSamples(trim);
  const video = [
    // Crop from the centre to the reel's shape, as the camera preview showed it.
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${width}:${height}`,
    'setsar=1',
    `fps=${FPS}:start_time=0`,
    'tpad=stop_mode=clone:stop_duration=1',
    `trim=end_frame=${frames}`,
    ...(assPath ? [`subtitles=filename='${filterPath(assPath)}':fontsdir='${filterPath(FONT_DIR)}'`] : []),
  ].join(',');
  // Gaps in the phone's sound filled with silence, so every word stays on its frame.
  const audio = [
    'aresample=48000:async=1:first_pts=0',
    ...(take.has_audio ? [AUDIO_CLEANUP, 'aresample=48000'] : []),
    'apad',
    `atrim=end_sample=${samples}`,
  ].join(',');
  const maxrate = maxrateFor(width, height);

  // Every piece gets identical stream settings so they can be joined without
  // re-encoding; a take without sound gets a silent track for the same reason.
  const args = ['-y', '-threads', THREADS, '-ss', trim.start.toFixed(3), '-t', duration.toFixed(3), '-i', take.file_path];
  if (!take.has_audio) args.push('-f', 'lavfi', '-t', duration.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  const audioIn = take.has_audio ? '0:a:0' : '1:a:0';
  let graph = `[0:v:0]${video}[v];[${audioIn}]${audio}[a]`;
  if (tag) {
    // The pill is sized from the frame's height, like the captions, so it keeps
    // the same size next to them in every shape: a third of the width in 9:16,
    // about a ninth in 16:9. Inset from the bottom-right corner.
    const tagIndex = take.has_audio ? 1 : 2;
    args.push('-i', TAG_IMAGE);
    const tagWidth = Math.round((height * 0.19) / 2) * 2;
    graph = `[0:v:0]${video}[base];[${tagIndex}:v]scale=${tagWidth}:-1:flags=lanczos[tag];[base][tag]overlay=x=W-w-${Math.round(height * 0.025)}:y=H-h-${Math.round(height * 0.03)}:format=auto[v];[${audioIn}]${audio}[a]`;
  }
  args.push(
    '-filter_threads', THREADS,
    '-filter_complex', graph,
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264', '-preset', PRESET, '-crf', '21', '-maxrate', `${maxrate}k`, '-bufsize', `${maxrate * 2}k`,
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-g', String(FPS * 2), '-threads', THREADS, '-x264-params', 'rc-lookahead=10',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-video_track_timescale', '15360',
    '-movflags', '+faststart',
    out,
  );
  await ffmpeg(args, { duration, onProgress });
}

// --- Pieces ----------------------------------------------------------------

const inflight = new Map(); // piece path -> { task, listeners }
// Pieces asked for in the last few minutes (a reel may be about to join them):
// kept when a newer edit of the same take finishes rendering.
const wanted = new Map(); // piece path -> when it was last asked for
const WANTED_MS = 15 * 60 * 1000;
const stillWanted = (file) => Date.now() - (wanted.get(file) ?? 0) < WANTED_MS;

/** Everything that changes how a take's piece looks, and the cache file for it. */
function pieceFor(take, { captions, tag, size, hook = null }) {
  const trim = trimFor(take);
  const chunks = captions ? captionChunks(take.words ?? [], take.caption_words ?? null, trim, take.caption_edits, take.language ?? 'Hinglish') : [];
  const key = createHash('sha1')
    .update(JSON.stringify({ v: PIECE_VERSION, trim, chunks, tag, size, hook, preset: PRESET }))
    .digest('hex')
    .slice(0, 16);
  return { trim, chunks, hook, out: path.join(takesDir, `${take.id}.piece-${key}.mp4`) };
}

/**
 * The take's piece for these settings: from the cache, from a render already
 * under way, or rendered now. Returns its path; `cached` when no work was needed.
 */
export async function ensurePiece(take, { captions = true, tag = true, size, hook = null }, { priority = 'low', onProgress } = {}) {
  if (!(await exists(take.file_path))) throw Object.assign(new Error('Take file missing'), { missing: Number(take.id) });
  const { trim, chunks, out } = pieceFor(take, { captions, tag, size, hook });
  wanted.set(out, Date.now());
  if (wanted.size > 2000) for (const [file, at] of wanted) if (Date.now() - at > WANTED_MS) wanted.delete(file);
  if (await exists(out)) return { out, trim, cached: true };

  let entry = inflight.get(out);
  if (!entry) {
    entry = { listeners: new Set() };
    entry.task = schedule(async () => {
      const tmp = `${out}.part.mp4`;
      const assPath = chunks.length || hook ? `${out}.ass` : null;
      try {
        if (assPath) await fs.promises.writeFile(assPath, assFile({ ...size, duration: trim.end - trim.start, chunks, hook }));
        await encodePiece({ take, trim, size, assPath, tag, out: tmp, onProgress: (p) => entry.listeners.forEach((fn) => fn(p)) });
        await fs.promises.rename(tmp, out);
        // Older pieces of this take (before an edit) won't be used again, unless one was asked for just now.
        const prefix = `${take.id}.piece-`;
        for (const name of await fs.promises.readdir(takesDir).catch(() => [])) {
          const file = path.join(takesDir, name);
          if (name.startsWith(prefix) && file !== out && !inflight.has(file.replace(/\.part\.mp4$|\.ass$/, '')) && !stillWanted(file)) {
            await fs.promises.rm(file, { force: true });
          }
        }
      } finally {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        if (assPath) await fs.promises.rm(assPath, { force: true }).catch(() => {});
        inflight.delete(out);
      }
    }, priority);
    inflight.set(out, entry);
  } else if (priority === 'high') {
    promote(entry.task);
  }
  if (onProgress) entry.listeners.add(onProgress);
  try {
    await entry.task.promise;
  } finally {
    if (onProgress) entry.listeners.delete(onProgress);
  }
  return { out, trim, cached: false };
}

/**
 * Starts making a kept take's piece in the background, with the settings its
 * reel will most likely use (captions on, the creator's plan, the hook on the
 * first shot), so the reel is ready to join by the time the last shot is kept.
 */
export function warmPiece(take, plan, hook = null) {
  if (!take?.file_path) return;
  const size = reelSizeFor(take, plan.maxLongEdge);
  ensurePiece(take, { captions: true, tag: plan.tag !== false, size, hook }).catch((err) => {
    if (!err.missing) console.error(`Pre-render of take ${take.id} failed:`, err.message);
  });
}

// --- Download sizes -----------------------------------------------------------

/** Smaller sizes a finished reel can also be saved in (short edge, in pixels). */
export const SAVE_SIZES = [1080, 720];
const copies = new Map(); // copy path -> promise

/**
 * A finished reel at a smaller size for saving to the phone: the short edge
 * scaled to `short` (1080 makes 9:16 into 1080×1920, 720 into 720×1280).
 * Made once, next to the reel; a reel already that small comes back as it is.
 */
export async function reelCopy(reel, short) {
  const scale = short / Math.min(reel.width, reel.height);
  if (!(scale < 1)) return reel.file_path;
  const out = path.join(path.dirname(reel.file_path), `reel-${short}p.mp4`);
  if (await exists(out)) return out;
  if (!copies.has(out)) {
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    const [w, h] = [even(reel.width * scale), even(reel.height * scale)];
    const maxrate = maxrateFor(w, h);
    const tmp = `${out}.part.mp4`;
    const run = async () => {
      try {
        await ffmpeg([
          '-y', '-threads', THREADS, '-i', reel.file_path,
          '-vf', `scale=${w}:${h}:flags=lanczos`,
          '-c:v', 'libx264', '-preset', PRESET, '-crf', '21', '-maxrate', `${maxrate}k`, '-bufsize', `${maxrate * 2}k`,
          '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-threads', THREADS,
          '-c:a', 'copy', '-movflags', '+faststart', tmp,
        ]);
        await fs.promises.rename(tmp, out);
        return out;
      } finally {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        copies.delete(out);
      }
    };
    copies.set(out, schedule(run, 'low').promise);
  }
  return copies.get(out);
}

// --- The job ---------------------------------------------------------------

async function buildReel(reel, job) {
  const dir = path.join(reelsDir, String(reel.id));
  const setStatus = async (status, extra = {}) => {
    Object.assign(job, { status, ...extra });
    await pool.query(
      'UPDATE reels SET status = $2, error = $3, file_path = $4, width = $5, height = $6, duration_seconds = $7 WHERE id = $1',
      [reel.id, status, extra.error ?? null, extra.filePath ?? null, extra.width ?? null, extra.height ?? null, extra.duration ?? null],
    );
  };

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    job.status = 'working';
    const takes = reel.takes;
    // One frame for the whole reel: the first shot's shape and resolution.
    const size = reelSizeFor(takes[0], reel.maxLongEdge);
    const settings = { captions: reel.captions, tag: reel.tag !== false, size };
    const lengths = takes.map((t) => {
      const trim = trimFor(t);
      return trim.end - trim.start;
    });
    const total = lengths.reduce((a, b) => a + b, 0) || 1;
    const done = takes.map(() => 0);
    const report = () => (job.progress = Math.min(0.95, (done.reduce((a, b) => a + b, 0) / total) * 0.95));

    // Ask for every piece at once (cached ones return straight away), then wait in order.
    job.stage = 'Editing your shots';
    // The hook goes on the first shot only.
    const pieces = takes.map((take, i) =>
      ensurePiece(take, { ...settings, hook: i === 0 ? (reel.hook ?? null) : null }, {
        priority: 'high',
        onProgress: (p) => {
          done[i] = p * lengths[i];
          job.stage = `Editing shot ${i + 1} of ${takes.length}`;
          report();
        },
      }).then((piece) => {
        done[i] = lengths[i];
        report();
        return piece;
      }),
    );
    const results = await Promise.all(pieces);

    job.stage = 'Joining the shots';
    const list = path.join(dir, 'pieces.txt');
    // Each piece's exact length, so the next one starts on the right frame.
    await fs.promises.writeFile(
      list,
      results.map((p) => `file '${p.out.replace(/'/g, "'\\''")}'\nduration ${(pieceFrames(p.trim) / FPS).toFixed(6)}`).join('\n'),
    );
    const filePath = path.join(dir, 'reel.mp4');
    // The picture is copied; the sound is cut to each piece's exact length and
    // encoded once for the whole reel. Copied end to end, each piece's sound brings
    // its encoder padding along, and players that play the samples back to back
    // fall a little further behind every shot.
    const audioGraph =
      results.map((p, i) => `[${i + 1}:a]atrim=end_sample=${pieceSamples(p.trim)},asetpts=N/SR/TB[a${i}]`).join(';') +
      `;${results.map((_, i) => `[a${i}]`).join('')}concat=n=${results.length}:v=0:a=1[a]`;
    await schedule(
      () =>
        ffmpeg([
          '-y', '-f', 'concat', '-safe', '0', '-i', list,
          ...results.flatMap((p) => ['-i', p.out]),
          '-filter_complex', audioGraph,
          '-map', '0:v', '-map', '[a]', '-c:v', 'copy',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
          '-movflags', '+faststart', filePath,
        ]),
      'high',
    ).promise;

    job.progress = 1;
    job.stage = 'Your reel is ready';
    await setStatus('done', { filePath, ...size, duration: total });
    // Have the smaller copies ready before anyone asks to save them.
    for (const short of SAVE_SIZES) {
      if (short < Math.min(size.width, size.height)) reelCopy({ id: reel.id, file_path: filePath, ...size }, short).catch((err) => console.error(`${short}p copy of reel ${reel.id} failed:`, err.message));
    }
  } catch (err) {
    console.error(`Reel ${reel.id} failed:`, err.message);
    job.stage = 'Something went wrong';
    await setStatus('error', { error: 'Making the reel failed. Try again.' }).catch(() => {});
  }
}
