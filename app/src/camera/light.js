// Darpan's light: where to put a soft virtual light on a take, and how it looks
// in the editor preview. The server applies the same light when it renders the
// reel (server/src/reels.js, lightFilter).
import { loadFaceDetector } from './vision.js';

export const DEFAULT_LIGHT = { x: 0.5, y: 0.28, strength: 0.5, warmth: 0.35 };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Looks at the frame on screen and suggests a light: beside the face on its
 * darker side and a little above the eyes, stronger when the face is dim.
 * Positions are fractions of the reel's frame (the video cropped to `aspect`).
 */
export async function suggestLight(video, aspect = 9 / 16) {
  if (!video?.videoWidth) return DEFAULT_LIGHT;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  // The reel crops the take from its centre to the reel's shape.
  const cw = vw / vh > aspect ? vh * aspect : vw;
  const ch = vw / vh > aspect ? vh : vw / aspect;
  const W = 180;
  const H = Math.round(W / aspect);
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, W, H);

  let face;
  try {
    face = (await loadFaceDetector()).detect(canvas).detections?.[0]?.boundingBox;
  } catch {}
  if (!face) return DEFAULT_LIGHT;

  const x0 = clamp(Math.round(face.originX), 0, W - 2);
  const y0 = clamp(Math.round(face.originY), 0, H - 2);
  const w = clamp(Math.round(face.width), 2, W - x0);
  const h = clamp(Math.round(face.height), 2, H - y0);
  const { data } = ctx.getImageData(x0, y0, w, h);
  let left = 0;
  let right = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (x < w / 2) left += luma;
      else right += luma;
    }
  }
  const half = (w / 2) * h * 255;
  left /= half;
  right /= half;
  const brightness = (left + right) / 2;
  const unevenness = left - right; // positive: the left side is brighter

  const faceX = (x0 + w / 2) / W;
  let x = faceX;
  // One side clearly darker: light that side, from just beyond the cheek.
  if (Math.abs(unevenness) > 0.05) x = faceX + Math.sign(unevenness) * (w / W) * 0.75;
  return {
    x: clamp(x, 0.06, 0.94),
    y: clamp((y0 + h * 0.2) / H, 0.05, 0.9),
    strength: clamp(0.3 + (0.6 - brightness) * 1.2 + Math.abs(unevenness), 0.3, 0.85),
    warmth: brightness < 0.35 ? 0.45 : 0.3,
  };
}

/** The editor preview's glow: a warm soft circle where the light is. */
export function glowStyle(light, height) {
  const warm = clamp(light.warmth, 0, 1);
  const color = `rgb(255 ${Math.round(244 - 54 * warm)} ${Math.round(225 - 120 * warm)} / ${(0.62 * clamp(light.strength, 0, 1)).toFixed(2)})`;
  return {
    background: `radial-gradient(circle ${Math.round(height * 0.34)}px at ${light.x * 100}% ${light.y * 100}%, ${color}, transparent)`,
  };
}
