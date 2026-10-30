// The phone's own motion sensors: which way up it is, how level, how still,
// and whether the camera points up or down.
//
// Gravity follows the W3C convention (phone upright: y = +g; lying screen-up:
// z = +g). iOS Safari reports the opposite sign, so its readings are flipped.

const G = 9.81;
const WINDOW_MS = 1000;
const IOS = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';

export class Motion {
  constructor() {
    this.samples = []; // { t, x, y, z, spin }
    this.available = false;
    this.sideways = false;
    this.onMotion = (e) => {
      const g = e.accelerationIncludingGravity;
      if (g?.x == null) return;
      const s = IOS ? -1 : 1;
      const r = e.rotationRate;
      const spin = r ? Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0) : 0; // degrees per second
      const t = performance.now();
      this.samples.push({ t, x: s * g.x, y: s * g.y, z: s * g.z, spin });
      while (this.samples.length && t - this.samples[0].t > WINDOW_MS) this.samples.shift();
      this.available = true;
    };
  }

  /** iOS asks before sharing motion; call from a tap. */
  static async permit() {
    if (!IOS) return true;
    try {
      return (await DeviceMotionEvent.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  start() {
    window.addEventListener('devicemotion', this.onMotion);
  }

  stop() {
    window.removeEventListener('devicemotion', this.onMotion);
  }

  /**
   * The last second, smoothed:
   *   sideways  held in landscape
   *   tilt      degrees off level, around the lens (0 = straight)
   *   pitch     degrees the camera's view points up (+) or down (-), as seen
   *             from the screen side; flip it for the back camera
   *   shake     RMS turning speed, degrees per second
   *   jolt      fastest turn in the window
   */
  read() {
    const n = this.samples.length;
    if (!this.available || n < 5 || performance.now() - this.samples[n - 1].t > 500) return null;
    let x = 0;
    let y = 0;
    let z = 0;
    let spinSq = 0;
    let jolt = 0;
    for (const s of this.samples) {
      x += s.x;
      y += s.y;
      z += s.z;
      spinSq += s.spin * s.spin;
      jolt = Math.max(jolt, s.spin);
    }
    x /= n;
    y /= n;
    z /= n;
    const upright = Math.hypot(x, y);
    // Hysteresis, so a phone held at 45° doesn't flip back and forth.
    if (Math.abs(x) > Math.abs(y) * 1.25) this.sideways = true;
    else if (Math.abs(y) > Math.abs(x) * 1.25) this.sideways = false;
    const deg = (r) => (r * 180) / Math.PI;
    const fromAxis = deg(Math.atan2(Math.abs(x), Math.abs(y)));
    return {
      sideways: this.sideways,
      // Around the lens only means something when the phone isn't lying flat.
      tilt: upright > 0.5 * G ? (this.sideways ? 90 - fromAxis : fromAxis) : null,
      pitch: deg(Math.atan2(z, upright)),
      gravity: [x / G, y / G, z / G],
      shake: Math.sqrt(spinSq / n),
      jolt,
    };
  }
}

/** Angle in degrees between two gravity readings. */
export function turnedBy(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = Math.hypot(...a) * Math.hypot(...b) || 1;
  return (Math.acos(Math.max(-1, Math.min(1, dot / len))) * 180) / Math.PI;
}
