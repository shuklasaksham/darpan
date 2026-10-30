import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function probe(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  const info = JSON.parse(stdout);
  const video = info.streams.find((s) => s.codec_type === 'video');
  return {
    hasAudio: info.streams.some((s) => s.codec_type === 'audio'),
    durationSeconds: Number(info.format.duration) || null,
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}

// Checked once: the health check is called every few seconds, and starting
// ffmpeg each time is slow while a reel is being encoded.
let available = null;
export function ffmpegAvailable() {
  available ??= run('ffmpeg', ['-version']).then(
    () => true,
    () => {
      available = null; // try again next time
      return false;
    },
  );
  return available;
}

/** One JPEG frame from a video, for thumbnails. */
export async function extractPoster(inputPath, outputPath, atSeconds = 0.5) {
  await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(atSeconds), '-i', inputPath, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', outputPath]);
  return outputPath;
}

/** A strip of `count` frames side by side across the whole video, for the trim bar. */
export async function extractStrip(inputPath, outputPath, durationSeconds, count = 8) {
  const fps = count / Math.max(0.5, durationSeconds);
  await run('ffmpeg', [
    '-v', 'error', '-y', '-i', inputPath,
    '-vf', `fps=${fps.toFixed(4)},scale=-2:96,tile=${count}x1`,
    '-frames:v', '1', '-q:v', '6', outputPath,
  ]);
  return outputPath;
}

/** Pulls a take's audio out as 16 kHz mono WAV for transcription. */
export async function extractAudio(inputPath, outputPath) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath]);
  return outputPath;
}
