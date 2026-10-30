// Where a body should sit in the frame for each kind of shot. Shared by the
// pose silhouettes and the framing checks.
//
// Bodies are described in "body units": 0 is the top of the head, 1 is the soles
// of the feet. Each framing places that body in the frame: `headTop` is where the
// top of the head should sit (fraction of frame height) and `scale` is how many
// frame heights one body is tall.

export const EYE = 0.065; // eye line, roughly the middle of the head
export const CHIN = 0.13;

export const FRAMINGS = {
  closeup: { headTop: 0.1, scale: 3.3, tolerance: 0.07, label: 'Close-up' },
  medium: { headTop: 0.09, scale: 1.95, tolerance: 0.06, label: 'Chest up' }, // 5–12% above the head
  waist_up: { headTop: 0.1, scale: 1.35, tolerance: 0.05, label: 'Waist up' },
  full_body: { headTop: 0.07, scale: 0.86, tolerance: 0.05, label: 'Full body' },
};

export function framingFor(name) {
  return FRAMINGS[name] ?? FRAMINGS.medium;
}

/** Where the eye line and chin should land for a framing, as fractions of frame height. */
export function targetsFor(name) {
  const f = framingFor(name);
  return {
    headTop: f.headTop,
    eye: f.headTop + EYE * f.scale,
    eyeToChin: (CHIN - EYE) * f.scale,
    tolerance: f.tolerance,
    scale: f.scale,
  };
}

/** The head's box in frame fractions: where to look for a face first. */
export function headRegion(framing, aspect) {
  const t = targetsFor(framing);
  const headH = CHIN * t.scale;
  const cy = t.headTop + EYE * t.scale;
  const h = Math.min(1, Math.max(0.16, headH * 3));
  const w = Math.min(1, h / aspect);
  return { x: 0.5 - w / 2, y: Math.max(0, cy - h / 2), w, h };
}
