import { useId } from 'react';

import { CHIN, EYE, framingFor } from './framing.js';

// Pose guides drawn as a ghost silhouette over the camera, like Photogenik.
// Body coordinates and framings are explained in framing.js; x = 0 is the
// body's centre line (viewer's left is negative).

const ARMS = {
  neutral: { l: [[-0.13, 0.34], [-0.14, 0.49]], r: [[0.13, 0.34], [0.14, 0.49]] },
  talking_gesture: { l: [[-0.13, 0.34], [-0.14, 0.49]], r: [[0.16, 0.33], [0.08, 0.27]] },
  pointing_side: { l: [[-0.13, 0.34], [-0.14, 0.49]], r: [[0.24, 0.22], [0.37, 0.19]] },
  hands_on_hips: { l: [[-0.21, 0.36], [-0.08, 0.5]], r: [[0.21, 0.36], [0.08, 0.5]] },
  arms_crossed: { l: [[-0.14, 0.33], [0.07, 0.31]], r: [[0.14, 0.33], [-0.07, 0.3]] },
  waving: { l: [[-0.13, 0.34], [-0.14, 0.49]], r: [[0.21, 0.2], [0.23, 0.04]] },
  holding_item: { l: [[-0.13, 0.35], [-0.05, 0.37]], r: [[0.13, 0.35], [0.05, 0.37]] },
  seated: { l: [[-0.13, 0.34], [-0.09, 0.5]], r: [[0.13, 0.34], [0.09, 0.5]] },
};

const LEGS = {
  standing: { l: [[-0.075, 0.74], [-0.075, 0.96], [-0.1, 0.99]], r: [[0.075, 0.74], [0.075, 0.96], [0.1, 0.99]] },
  // Sitting facing the phone: thighs point at the lens, so they look short.
  seated: { l: [[-0.09, 0.63], [-0.09, 0.9], [-0.11, 0.93]], r: [[0.09, 0.63], [0.09, 0.9], [0.11, 0.93]] },
};

function skeleton(pose) {
  const arms = ARMS[pose] ?? ARMS.neutral;
  const legs = pose === 'seated' ? LEGS.seated : LEGS.standing;
  const shoulders = { l: [-0.105, 0.18], r: [0.105, 0.18] };
  const hips = { l: [-0.075, 0.52], r: [0.075, 0.52] };
  return {
    head: { c: [0, EYE], rx: 0.05, ry: 0.066 },
    neck: [[0, 0.11], [0, 0.17]],
    torso: [shoulders.l, shoulders.r, [0.08, 0.36], hips.r, hips.l, [-0.08, 0.36]],
    limbs: [
      [shoulders.l, ...arms.l],
      [shoulders.r, ...arms.r],
      [hips.l, ...legs.l],
      [hips.r, ...legs.r],
    ],
  };
}

/**
 * Translucent outline of the pose in the planned framing. `aspect` is the
 * frame's width / height; `matched` turns it green.
 */
export function Silhouette({ framing, pose, aspect, matched, mirrored }) {
  const maskId = useId();
  const { headTop, scale } = framingFor(framing);
  const H = 1000;
  const W = aspect * H;
  const pt = ([x, y]) => [W / 2 + x * scale * H, (headTop + y * scale) * H];
  const s = skeleton(pose);
  const limbWidth = 0.055 * scale * H;
  const [hx, hy] = pt(s.head.c);
  const torso = s.torso.map((p) => pt(p).join(',')).join(' ');
  const limbs = s.limbs.map((l) => l.map((p) => pt(p).join(',')).join(' '));
  const neck = s.neck.map((p) => pt(p).join(',')).join(' ');

  // A wide pass masked by a narrow one leaves a single clean outline around the
  // union of all the parts, so the creator's face is never covered.
  const shapes = (stroke, fill, extra) => (
    <g stroke={stroke} fill={fill} strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx={hx} cy={hy} rx={s.head.rx * scale * H + extra / 2} ry={s.head.ry * scale * H + extra / 2} strokeWidth={0} fill={stroke} />
      <polygon points={torso} strokeWidth={limbWidth * 0.6 + extra} />
      <polyline points={neck} fill="none" strokeWidth={limbWidth * 0.9 + extra} />
      {limbs.map((points, i) => (
        <polyline key={i} points={points} fill="none" strokeWidth={limbWidth + extra} />
      ))}
    </g>
  );
  const outline = matched ? '#5fc08a' : '#ffffff';

  return (
    <svg
      className="silhouette"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId}>
          <rect width={W} height={H} fill="white" />
          {shapes('black', 'black', 0)}
        </mask>
      </defs>
      <g opacity={0.1}>{shapes(outline, outline, 0)}</g>
      <g mask={`url(#${maskId})`} opacity={0.9}>
        {shapes(outline, outline, 10)}
      </g>
    </svg>
  );
}
