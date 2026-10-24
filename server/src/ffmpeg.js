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

export async function ffmpegAvailable() {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** Pulls a take's audio out as 16 kHz mono WAV for transcription. */
export async function extractAudio(inputPath, outputPath) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath]);
  return outputPath;
}
