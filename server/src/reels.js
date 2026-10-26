import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { pool } from './db.js';
import { findFillers } from './analyze.js';
import { transliterateWord } from './usernames.js';
import { claudeConfigured, hinglishCaptions } from './claude.js';

// Builds a reel from kept takes:
//   1. each take is trimmed to its speech, scaled to the reel size, and has its
//      captions and the "Shot with Darpan" tag burned in (one encode per take,
//      all with identical settings), then
//   2. the pieces are joined with ffmpeg's concat demuxer without re-encoding.
// Jobs run one at a time: the server has 512 MB and ffmpeg needs most of it.

export const takesDir = path.join(config.uploadDir, 'takes');
export const reelsDir = path.join(config.uploadDir, 'reels');
fs.mkdirSync(takesDir, { recursive: true });
fs.mkdirSync(reelsDir, { recursive: true });

const FONT_DIR = '/usr/share/fonts/truetype/dejavu';
const FONT = 'DejaVu Sans';
const MAX_LONG_EDGE = 1920; // Reels top out at 1080×1920
const LEAD_IN = 0.15; // seconds kept before the first word
const TAIL = 0.4; // and after the last, so nothing sounds clipped
const FPS = 30;

const jobs = new Map(); // reelId -> { status, progress, stage, error }
let queue = Promise.resolve();

export function jobStatus(reelId) {
  return jobs.get(String(reelId)) ?? null;
}

export function enqueueReel(reel) {
  const job = { status: 'queued', progress: 0, stage: 'Waiting for the editing room' };
  jobs.set(String(reel.id), job);
  queue = queue.then(() => buildReel(reel, job)).catch(() => {});
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

/**
 * The reel uses the first take's aspect ratio, at the highest resolution any
 * take reaches at that ratio (cropping, never padding), capped so the long
 * edge is at most 1920 (Reels' 1080×1920). Smaller takes are scaled up to it.
 * Dimensions are even, as H.264 needs.
 */
export function reelSize(takes, maxLongEdge = MAX_LONG_EDGE) {
  const aspect = takes[0].width / takes[0].height;
  // Widest frame at this ratio that fits inside each take.
  const widest = Math.max(...takes.map((t) => Math.min(t.width, t.height * aspect)));
  let width = widest;
  let height = widest / aspect;
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  width *= scale;
  height *= scale;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(width), height: even(height) };
}

/**
 * Caption lines for one take: filler words dropped, Devanagari turned into
 * Roman Hinglish, grouped into short chunks timed to the speech. `edits` holds
 * the creator's fixes by word index; an empty string drops the word, and an
 * edited filler is kept.
 */
export function captionChunks(words, hinglish, trim, edits = null) {
  const skip = new Set(findFillers(words).flatMap((f) => f.indices));
  const edited = (i) => edits && Object.hasOwn(edits, i);
  const kept = words
    .map((w, i) => ({ ...w, caption: (edited(i) ? String(edits[i]) : (hinglish?.[i] ?? toHinglish(w.text))).trim() }))
    .filter((w, i) => (edited(i) || !skip.has(i)) && w.caption && w.end > trim.start && w.start < trim.end);

  const chunks = [];
  let current = [];
  kept.forEach((w, i) => {
    current.push(w);
    const next = kept[i + 1];
    const chars = current.reduce((n, x) => n + x.caption.length + 1, 0);
    const breakHere =
      !next || current.length >= 4 || chars > 22 || /[.!?।,]$/.test(w.caption) || next.start - w.end > 0.45;
    if (breakHere) {
      chunks.push(current);
      current = [];
    }
  });
  return chunks.map((c, i) => {
    const next = chunks[i + 1];
    const start = Math.max(0, c[0].start - trim.start);
    const end = Math.min(trim.end - trim.start, next ? next[0].start - trim.start : c[c.length - 1].end - trim.start + 0.5);
    return { start, end: Math.max(end, start + 0.3), text: c.map((w) => w.caption).join(' ') };
  });
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

/** Subtitle file with the captions (lower middle, above Reels' own UI) and the tag. */
export function assFile({ width, height, duration, chunks, tag = true }) {
  const size = Math.round(height * 0.042);
  const tagSize = Math.round(height * 0.022);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${FONT},${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size * 0.09))},${Math.round(size * 0.04)},2,${Math.round(width * 0.08)},${Math.round(width * 0.08)},${Math.round(height * 0.3)},1
Style: Tag,${FONT},${tagSize},&H30FFFFFF,&H000000FF,&H60000000,&H00000000,-1,0,0,0,100,100,1,0,1,${Math.max(1, Math.round(tagSize * 0.08))},0,8,10,10,${Math.round(height * 0.06)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${tag ? `Dialogue: 0,${assTime(0)},${assTime(duration + 1)},Tag,,0,0,0,,Shot with Darpan\n` : ''}${chunks.map((c) => `Dialogue: 1,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${assText(c.text)}`).join('\n')}
`;
}

// --- Running ffmpeg --------------------------------------------------------

/** Runs ffmpeg, reporting progress (0-1) from its -progress output. */
function ffmpeg(args, { duration, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...args]);
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

async function encodePiece({ take, trim, size, assPath, out, onProgress }) {
  const duration = trim.end - trim.start;
  const { width, height } = size;
  const video = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic`,
    `crop=${width}:${height}`,
    'setsar=1',
    `fps=${FPS}`,
    `subtitles=filename='${filterPath(assPath)}':fontsdir='${filterPath(FONT_DIR)}'`,
  ].join(',');

  // Every piece gets identical stream settings so they can be joined without
  // re-encoding; a take without sound gets a silent track for the same reason.
  // One thread for decoding, filters and x264: measured at about 180-215 MB for a
  // 1080x1920 piece, against 500 MB+ with ffmpeg's default of a thread per core.
  const args = ['-y', '-threads', '1', '-ss', trim.start.toFixed(3), '-t', duration.toFixed(3), '-i', take.file_path];
  if (!take.has_audio) args.push('-f', 'lavfi', '-t', duration.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  args.push(
    '-map', '0:v:0',
    '-map', take.has_audio ? '0:a:0' : '1:a:0',
    '-filter_threads', '1',
    '-vf', video,
    // ultrafast: ~2.6x quicker than veryfast on Render's small CPUs, at a larger file size.
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-g', String(FPS * 2), '-threads', '1', '-x264-params', 'rc-lookahead=10',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-video_track_timescale', '15360',
    '-movflags', '+faststart',
    out,
  );
  await ffmpeg(args, { duration, onProgress });
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
    job.stage = 'Getting your takes ready';
    const takes = reel.takes;
    const trims = takes.map(trimFor);
    const size = reelSize(takes, reel.maxLongEdge);
    const total = trims.reduce((n, t) => n + (t.end - t.start), 0);

    // Hinglish spellings for every word, from Claude when available.
    let hinglish = takes.map(() => null);
    if (reel.captions && claudeConfigured) {
      job.stage = 'Writing your captions';
      try {
        // Don't let caption spelling hold up the render: local transliteration after 8 s.
        hinglish = await Promise.race([
          hinglishCaptions(takes.map((t) => (t.words ?? []).map((w) => w.text))),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000)),
        ]);
      } catch (err) {
        console.error('Hinglish captions from Claude failed, transliterating:', err.message);
      }
    }

    const pieces = [];
    let done = 0;
    for (const [i, take] of takes.entries()) {
      const trim = trims[i];
      const duration = trim.end - trim.start;
      job.stage = `Editing shot ${i + 1} of ${takes.length}`;
      const chunks = reel.captions ? captionChunks(take.words ?? [], hinglish[i], trim, take.caption_edits) : [];
      const assPath = path.join(dir, `piece-${i}.ass`);
      await fs.promises.writeFile(assPath, assFile({ ...size, duration, chunks, tag: reel.tag !== false }));
      const out = path.join(dir, `piece-${i}.mp4`);
      await encodePiece({
        take,
        trim,
        size,
        assPath,
        out,
        onProgress: (p) => (job.progress = Math.min(0.95, ((done + p * duration) / total) * 0.95)),
      });
      done += duration;
      pieces.push(out);
    }

    job.stage = 'Joining the shots';
    const list = path.join(dir, 'pieces.txt');
    await fs.promises.writeFile(list, pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const filePath = path.join(dir, 'reel.mp4');
    await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', filePath]);

    await Promise.all(pieces.map((p) => fs.promises.rm(p, { force: true })));
    job.progress = 1;
    job.stage = 'Your reel is ready';
    await setStatus('done', { filePath, ...size, duration: total });
  } catch (err) {
    console.error(`Reel ${reel.id} failed:`, err.message);
    job.stage = 'Something went wrong';
    await setStatus('error', { error: 'Making the reel failed. Try again.' }).catch(() => {});
  }
}
