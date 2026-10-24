import { targetsFor } from './framing.js';

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
  return { headTop, feetVisible, feetY, hipsVisible, height: feetY - headTop };
}

/** Framing problems, most important first. */
export function framingProblems({ framing, face, body, hasFace }) {
  const t = targetsFor(framing);
  const problems = [];

  if (framing === 'full_body') {
    if (!body) return [{ id: 'no_body' }];
    if (body.headTop < 0.005) problems.push({ id: 'raise_phone', why: 'head cut off' });
    else if (!body.feetVisible) problems.push({ id: 'show_feet' });
    else if (body.height < 0.6) problems.push({ id: 'come_closer' });
    else if (body.headTop > t.headTop + 0.12) problems.push({ id: 'lower_phone', why: 'body low in frame' });
    if (face) problems.push(...horizontal(face));
    return problems;
  }

  if (!hasFace) return [{ id: 'no_face' }];

  // Size first: someone too close also gets their head cut off, and stepping
  // back is the fix for both.
  const size = face.eyeToChin / t.eyeToChin;
  if (size > 1.45) problems.push({ id: 'move_back' });
  else if (face.headTop < 0.005) problems.push({ id: 'raise_phone', why: 'head cut off' });
  else if (size < 0.68) problems.push({ id: 'come_closer' });
  else if (face.eyeY > t.eye + t.tolerance) problems.push({ id: 'lower_phone', why: 'face low in frame' });
  else if (face.eyeY < t.eye - t.tolerance) problems.push({ id: 'raise_phone', why: 'too little headroom' });
  if (framing === 'waist_up' && body && !body.hipsVisible && size <= 1.45) {
    problems.push({ id: 'move_back', why: 'hands and waist not visible' });
  }
  problems.push(...horizontal(face));
  return problems;
}

function horizontal(face) {
  // The camera sees the creator's right side on the left of the image, so a
  // face on the image's left means they should move to their own left.
  if (face.centerX < 0.32) return [{ id: 'step_left' }];
  if (face.centerX > 0.68) return [{ id: 'step_right' }];
  return [];
}

// --- Light -----------------------------------------------------------------

/**
 * Reads only the middle of the face (between the eyes and the mouth: cheeks
 * and nose, no hair or background) plus whole-frame quality figures.
 */
export function lightReadings(image, face) {
  const { data, width, height } = image;
  const luma = new Float32Array(width * height);
  let sum = 0;
  let sumSq = 0;
  let hi = 0;
  let lo = 0;
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    const l = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
    luma[i] = l;
    sum += l;
    sumSq += l * l;
    if (l > 0.97) hi++;
    if (l < 0.03) lo++;
  }
  const n = luma.length;
  const mean = sum / n;

  // Sharpness: mean absolute Laplacian. Low values mean blur or a smudged lens.
  let lap = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      lap += Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width]);
    }
  }

  const readings = {
    frame: mean,
    contrast: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    clippedHigh: hi / n,
    clippedLow: lo / n,
    sharpness: lap / ((width - 2) * (height - 2)),
    face: null,
    background: null,
  };
  if (!face) return readings;

  const [[ex0], [ex1]] = face.eyes;
  const left = Math.min(ex0, ex1);
  const right = Math.max(ex0, ex1);
  const top = (face.eyes[0][1] + face.eyes[1][1]) / 2;
  const bottom = face.mouth[1];
  readings.face = regionMean(luma, width, height, left, top, right, Math.max(bottom, top + 0.01));

  // Background: the upper part of the frame away from the face and body,
  // where a window behind someone would be.
  const pad = 0.6;
  const bx0 = face.box.x - face.box.w * pad;
  const bx1 = face.box.x + face.box.w * (1 + pad);
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
  return readings;
}

function regionMean(luma, width, height, x0, y0, x1, y1) {
  const xa = Math.max(0, Math.floor(x0 * width));
  const xb = Math.min(width - 1, Math.ceil(x1 * width));
  const ya = Math.max(0, Math.floor(y0 * height));
  const yb = Math.min(height - 1, Math.ceil(y1 * height));
  let s = 0;
  let n = 0;
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++, n++) s += luma[y * width + x];
  return n ? s / n : null;
}

export const LIGHT = {
  faceDark: 0.3,
  backlitFace: 0.36,
  backlitGap: 0.28, // background at least this much brighter than the face
  faceBright: 0.88,
  roomDark: 0.16,
  blurry: 0.005, // tune with ?debug on real phones; flat test images read ~0.005
};

export function lightProblems(r) {
  const problems = [];
  if (r.face != null) {
    // A bright wall behind someone is fine; it's only backlight when the face
    // itself is dark AND much darker than what's behind it.
    const backlit =
      r.background != null && r.face < LIGHT.backlitFace && r.background - r.face > LIGHT.backlitGap;
    if (backlit) problems.push({ id: 'backlight' });
    else if (r.face < LIGHT.faceDark) problems.push({ id: 'face_dark' });
    else if (r.face > LIGHT.faceBright) problems.push({ id: 'face_bright' });
  } else if (r.frame < LIGHT.roomDark) {
    problems.push({ id: 'room_dark' });
  }
  if (r.sharpness < LIGHT.blurry && r.contrast > 0.08) problems.push({ id: 'blurry' });
  return problems;
}

// --- Sound -----------------------------------------------------------------

export const SOUND = { noisyFloorDb: -38, silentDb: -85, clipDb: -1 };

export function soundProblems(s, { recording }) {
  if (!s) return [];
  if (s.rmsDb < SOUND.silentDb && s.windowMs > 2000) return [{ id: 'mic_silent' }];
  if (s.peakDb > SOUND.clipDb) return [{ id: 'too_loud' }];
  // Background noise only matters before a take; while recording the creator is talking.
  if (!recording && s.floorDb > SOUND.noisyFloorDb) return [{ id: 'noisy' }];
  return [];
}
