import { SIDES } from './standards.js';
import { turnedBy } from './motion.js';

// The Shooting Standards' checks that the phone can measure itself. Each
// returns failing checks as { id, fill? }; the coach decides what to say.
//
// All positions are fractions of the (cropped) frame: x left→right as the
// camera sees it (not mirrored), y top→bottom. Brightness is 0–1 luma.

// --- Face geometry ---------------------------------------------------------

/** Eye line, estimated top of head and face size from a detected face. */
export function faceGeometry(face) {
  const eyeY = (face.eyes[0][1] + face.eyes[1][1]) / 2;
  const chinY = face.box.y + face.box.h;
  const eyeToChin = Math.max(0.001, chinY - eyeY);
  // The eyes sit roughly halfway down the head, so the skull top is about as
  // far above them as the chin is below.
  const headTop = eyeY - eyeToChin;
  const centerX = face.box.x + face.box.w / 2;
  return { eyeY, chinY, eyeToChin, headTop, centerX };
}

// MediaPipe pose landmark indices.
const NOSE = 0;
const SHOULDERS = [11, 12];
const HIPS = [23, 24];
const ANKLES = [27, 28];
const HEELS = [29, 30];

const visible = (p, min = 0.5) => p && p.visibility >= min && p.y > -0.02 && p.y < 1.02;

export function bodyGeometry(landmarks, face) {
  if (!landmarks) return null;
  const nose = landmarks[NOSE];
  const shoulderY = (landmarks[SHOULDERS[0]].y + landmarks[SHOULDERS[1]].y) / 2;
  const headTop = face ? face.headTop : nose.y - (shoulderY - nose.y) * 0.9;
  const feet = [...ANKLES, ...HEELS].map((i) => landmarks[i]);
  const feetVisible = feet.every((p) => visible(p)) && feet.every((p) => p.y < 0.985);
  const feetY = Math.max(...feet.map((p) => p.y));
  const hipsVisible = HIPS.every((i) => visible(landmarks[i]));
  return { headTop, feetVisible, feetY, hipsVisible, height: feetY - headTop, centerX: nose.x };
}

// --- 4.4 Distance and framing ----------------------------------------------

// Face width as a share of the frame width. The standards give the talking
// shot in vertical video (25–40%); the others follow from the same distances,
// and landscape from "one to one and a half metres away".
const FACE_WIDTH = {
  vertical: { closeup: [0.35, 0.6], medium: [0.25, 0.4], waist_up: [0.15, 0.27] },
  landscape: { closeup: [0.13, 0.24], medium: [0.07, 0.14], waist_up: [0.05, 0.1] },
};
export const HEADROOM = { min: 0, max: 0.12 }; // gap above the head: 5–12% is the target; 0 is cut
const EYES_LOW = 0.42; // eyes well below one third: too much space above
// Keep clear (section 3): Reels and Shorts cover the bottom ~25% with the
// caption; landscape keeps the bottom 10% for the progress bar.
const CAPTION_LINE = { vertical: 0.75, landscape: 0.9 };

const DEFAULT_TOPIC = { en: 'body', hinglish: 'body', hi: 'शरीर', hs: 'बॉडी' };

export function framingProblems({ framing, face, body, hasFace, aspect, topic = null }) {
  const shape = aspect > 1.01 ? 'landscape' : 'vertical';
  const problems = [];

  if (framing === 'full_body') {
    if (!body) return [{ id: 'NOFACE' }];
    if (body.headTop < 0.005) problems.push({ id: 'F3' });
    else if (!body.feetVisible) problems.push({ id: 'F6', fill: topic ?? DEFAULT_TOPIC });
    else if (body.height < (shape === 'vertical' ? 0.6 : 0.7)) problems.push({ id: 'F2' });
    else if (body.headTop > HEADROOM.max) problems.push({ id: 'F4' });
    problems.push(...sideways(face ?? { centerX: body.centerX, box: null }, shape));
    return problems;
  }

  if (!hasFace) return [{ id: 'NOFACE' }];
  const [small, big] = (FACE_WIDTH[shape][framing] ?? FACE_WIDTH[shape].medium);
  const width = face.box.w;
  if (width > big || face.chinY > 1) problems.push({ id: 'F1' });
  else if (face.headTop < HEADROOM.min) problems.push({ id: 'F3' });
  else if (width < small) problems.push({ id: 'F2' });
  else if (face.headTop > HEADROOM.max || face.eyeY > EYES_LOW) problems.push({ id: 'F4' });
  problems.push(...sideways(face, shape));
  if (face.chinY > CAPTION_LINE[shape] && face.chinY <= 1) problems.push({ id: 'F7' });
  return problems;
}

function sideways(face, shape) {
  // The camera sees the creator's left side on the right of the image, so a
  // face on the image's left means they should move to their own left.
  // Vertical: centred. Landscape: slightly off-centre is the rule of thirds.
  const [lo, hi] = shape === 'vertical' ? [0.38, 0.62] : [0.2, 0.8];
  const box = face.box;
  if (face.centerX < lo || (box && box.x < 0)) return [{ id: 'F5', fill: SIDES.left }];
  if (face.centerX > hi || (box && box.x + box.w > 1)) return [{ id: 'F5', fill: SIDES.right }];
  return [];
}

// --- 4.1, 4.2, 4.5 From the motion sensors -----------------------------------

export const STEADY = { tilt: 3, shake: 4, jolt: 90, moved: 12 };
export const ANGLE = { up: 15, down: -15, fullBodyDown: -8 };

/**
 * Orientation, level, stillness and camera height. `takeGravity` is the
 * phone's gravity when the take started, to notice it moving mid-take.
 */
export function motionProblems(m, { aspect, facing, framing, recording, takeGravity }) {
  if (!m) return [];
  const problems = [];
  if (aspect < 0.99 && m.sideways) problems.push({ id: 'O1' });
  if (aspect > 1.01 && !m.sideways) problems.push({ id: 'O2' });
  if (m.tilt != null && m.tilt > STEADY.tilt) problems.push({ id: 'S1' });
  if (recording) {
    if (m.jolt > STEADY.jolt || (takeGravity && turnedBy(takeGravity, m.gravity) > STEADY.moved)) problems.push({ id: 'S3' });
    return problems;
  }
  if (m.shake > STEADY.shake) problems.push({ id: 'S2' });
  // Positive: the camera looks up at the creator. The front camera looks out of
  // the screen side; the back camera the other way.
  const view = facing === 'user' ? m.pitch : -m.pitch;
  if (view > ANGLE.up) problems.push({ id: 'A1' });
  else if (framing === 'full_body' ? view < ANGLE.fullBodyDown : view < ANGLE.down) problems.push({ id: framing === 'full_body' ? 'A3' : 'A2' });
  return problems;
}

// --- 4.3 Light, 4.8 Lens ----------------------------------------------------

/**
 * Brightness of the middle of the face (cheeks and nose, no hair or
 * background), the forehead against the cheeks (light from above), the two
 * sides of the face, the background, and how sharp the face and the
 * background are. Also returns the luma, for the background-movement check.
 */
export function lightReadings(image, face) {
  const { data, width, height } = image;
  const luma = new Float32Array(width * height);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    const l = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
    luma[i] = l;
    sum += l;
    sumSq += l * l;
  }
  const n = luma.length;
  const mean = sum / n;

  const readings = {
    luma,
    width,
    height,
    frame: mean,
    contrast: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    // Sharpness: mean absolute Laplacian. Low values mean blur or a smudged lens.
    sharpness: sharpness(luma, width, height, 0, 0, 1, 1),
    face: null,
    background: null,
  };
  if (!face) return readings;

  const { box } = face;
  const [[ex0], [ex1]] = face.eyes;
  const left = Math.min(ex0, ex1);
  const right = Math.max(ex0, ex1);
  const eyeY = (face.eyes[0][1] + face.eyes[1][1]) / 2;
  const bottom = Math.max(face.mouth[1], eyeY + 0.01);
  const span = Math.max(0.01, bottom - eyeY);
  readings.face = regionMean(luma, width, height, left, eyeY, right, bottom);
  // Forehead: between the top of the box and the brows.
  readings.forehead = regionMean(luma, width, height, left, box.y + box.h * 0.04, right, eyeY - span * 0.7);
  // Just under the eyes, where light from above leaves shadows.
  readings.underEyes = regionMean(luma, width, height, left, eyeY + span * 0.25, right, eyeY + span * 0.6);
  // The two halves of the face, eyes to mouth, nose strip left out.
  const mid = (left + right) / 2;
  const gap = (right - left) * 0.12;
  readings.sideA = regionMean(luma, width, height, box.x + box.w * 0.08, eyeY, mid - gap, bottom);
  readings.sideB = regionMean(luma, width, height, mid + gap, eyeY, box.x + box.w * 0.92, bottom);
  readings.faceSharpness = sharpness(luma, width, height, box.x, box.y, box.x + box.w, box.y + box.h);

  // Background: the upper part of the frame away from the face and body,
  // where a window behind someone would be.
  const pad = 0.6;
  const bx0 = box.x - box.w * pad;
  const bx1 = box.x + box.w * (1 + pad);
  let bgSum = 0;
  let bgN = 0;
  const maxY = Math.floor(height * 0.6);
  for (let y = 0; y < maxY; y++) {
    for (let x = 0; x < width; x++) {
      const fx = x / width;
      if (fx >= bx0 && fx <= bx1) continue;
      bgSum += luma[y * width + x];
      bgN++;
    }
  }
  readings.background = bgN > 20 ? bgSum / bgN : null;
  const bgSharpA = bx0 > 0.08 ? sharpness(luma, width, height, 0, 0, bx0, 0.6) : null;
  const bgSharpB = bx1 < 0.92 ? sharpness(luma, width, height, bx1, 0, 1, 0.6) : null;
  readings.backgroundSharpness = Math.max(bgSharpA ?? 0, bgSharpB ?? 0) || null;
  return readings;
}

function regionMean(luma, width, height, x0, y0, x1, y1) {
  const xa = Math.max(0, Math.floor(x0 * width));
  const xb = Math.min(width - 1, Math.ceil(x1 * width));
  const ya = Math.max(0, Math.floor(y0 * height));
  const yb = Math.min(height - 1, Math.ceil(y1 * height));
  if (xb < xa || yb < ya) return null;
  let s = 0;
  let n = 0;
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++, n++) s += luma[y * width + x];
  return n ? s / n : null;
}

function sharpness(luma, width, height, x0, y0, x1, y1) {
  const xa = Math.max(1, Math.floor(x0 * width));
  const xb = Math.min(width - 2, Math.ceil(x1 * width));
  const ya = Math.max(1, Math.floor(y0 * height));
  const yb = Math.min(height - 2, Math.ceil(y1 * height));
  let lap = 0;
  let n = 0;
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++, n++) {
      const i = y * width + x;
      lap += Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width]);
    }
  }
  return n ? lap / n : 0;
}

export const LIGHT = {
  faceDark: 0.3,
  backlitFace: 0.36,
  backlitGap: 0.28, // background at least this much brighter than the face
  roomDark: 0.16,
  topLight: 0.16, // forehead this much brighter than under the eyes
  topLightForehead: 0.45,
  sideRatio: 0.6, // darker side under 60% of the brighter one
  sideGap: 0.15,
  blurry: 0.005, // tune with ?debug on real phones; flat test images read ~0.005
  softFace: 0.55, // face sharpness under 55% of the background's: focused behind
  hunting: 0.09, // brightness swinging this much while nothing moves
};

/** L1–L4 and C1–C2. `focusable`: the phone lets the creator tap to focus. */
export function lightProblems(r, { focusable = false } = {}) {
  const problems = [];
  if (r.face != null) {
    // A bright wall behind someone is fine; it's only backlight when the face
    // itself is dark AND much darker than what's behind it.
    const backlit = r.background != null && r.face < LIGHT.backlitFace && r.background - r.face > LIGHT.backlitGap;
    if (backlit) problems.push({ id: 'L1' });
    else if (r.face < LIGHT.faceDark) problems.push({ id: 'L2' });
    if (!backlit && r.face >= LIGHT.faceDark) {
      if (r.forehead != null && r.underEyes != null && r.forehead > LIGHT.topLightForehead && r.forehead - r.underEyes > LIGHT.topLight) {
        problems.push({ id: 'L3' });
      }
      if (r.sideA != null && r.sideB != null) {
        const lo = Math.min(r.sideA, r.sideB);
        const hi = Math.max(r.sideA, r.sideB);
        if (hi - lo > LIGHT.sideGap && lo < hi * LIGHT.sideRatio) problems.push({ id: 'L4' });
      }
    }
  } else if (r.frame < LIGHT.roomDark) {
    problems.push({ id: 'L2' });
  }
  if (r.sharpness < LIGHT.blurry && r.contrast > 0.08) problems.push({ id: 'C1' });
  else if (
    focusable &&
    r.faceSharpness != null &&
    r.backgroundSharpness != null &&
    r.backgroundSharpness > LIGHT.blurry * 2 &&
    r.faceSharpness < r.backgroundSharpness * LIGHT.softFace
  ) {
    problems.push({ id: 'C2' });
  }
  return problems;
}

/** L6: brightness hunting up and down while the phone and creator are still. */
export class ExposureWatch {
  constructor() {
    this.points = []; // [t, frame mean]
  }

  push(t, mean) {
    this.points.push([t, mean]);
    while (this.points.length && t - this.points[0][0] > 3000) this.points.shift();
  }

  clear() {
    this.points = [];
  }

  hunting() {
    if (this.points.length < 6) return false;
    const values = this.points.map((p) => p[1]);
    if (Math.max(...values) - Math.min(...values) < LIGHT.hunting) return false;
    // Up, down and up again (or the reverse): not just a light switched on.
    let turns = 0;
    let dir = 0;
    for (let i = 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      if (Math.abs(d) < 0.015) continue;
      const s = Math.sign(d);
      if (dir && s !== dir) turns++;
      dir = s;
    }
    return turns >= 2;
  }
}

// --- 4.6 Background ---------------------------------------------------------

/**
 * B4: someone or something moving behind the creator. Compares frames outside
 * the creator (the face's columns and everything below it are left out).
 */
export class BackgroundWatch {
  constructor() {
    this.prev = null;
  }

  clear() {
    this.prev = null;
  }

  /** Share of background pixels that changed since the last frame. */
  moving(r, face) {
    const { luma, width, height } = r;
    const prev = this.prev?.length === luma.length ? this.prev : null;
    this.prev = luma;
    if (!prev || !face) return 0;
    const x0 = face.box.x - face.box.w * 1.0;
    const x1 = face.box.x + face.box.w * 2.0;
    let changed = 0;
    let total = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const fx = x / width;
        if (fx > x0 && fx < x1 && y / height > face.box.y - face.box.h * 0.5) continue;
        const i = y * width + x;
        total++;
        if (Math.abs(luma[i] - prev[i]) > 0.12) changed++;
      }
    }
    return total > 50 ? changed / total : 0;
  }
}

export const BACKGROUND_MOVING = 0.04;

// --- 4.7 Sound -----------------------------------------------------------------

export const SOUND = { noisyFloorDb: -38, silentDb: -85, clipDb: -1, quietVoiceDb: -30, voiceOverFloorDb: 12 };
const DEFAULT_NOISE = { en: 'fan', hinglish: 'fan', hi: 'पंखा', hs: 'फ़ैन' };

/** SD1, SD2, SD4, and a dead mic. `noise`: what Claude saw making noise. */
export function soundProblems(s, { recording, noise = null }) {
  if (!s) return [];
  if (s.rmsDb < SOUND.silentDb && s.windowMs > 2000) return [{ id: 'MIC' }];
  if (s.peakDb > SOUND.clipDb) return [{ id: 'SD4' }];
  if (recording) return [];
  // Background noise only matters before a take; while recording the creator is talking.
  if (s.floorDb > SOUND.noisyFloorDb) return [{ id: 'SD1', fill: noise ?? DEFAULT_NOISE }];
  // Someone talking (well above the room) but quietly: too far or too soft.
  if (s.windowMs > 2000 && s.peakDb - s.floorDb > SOUND.voiceOverFloorDb && s.peakDb < SOUND.quietVoiceDb) return [{ id: 'SD2' }];
  return [];
}
