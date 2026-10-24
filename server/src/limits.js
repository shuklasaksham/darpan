// Small in-memory rate limits for the endpoints that cost money (Claude,
// Deepgram, Sarvam, ffmpeg) or invite abuse (sign-up). One server instance, so
// memory is enough; move to Postgres or Redis if you run more than one.

const buckets = new Map(); // key -> timestamps (ms)

function hit(key, max, windowMs, now = Date.now()) {
  const list = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    buckets.set(key, list);
    return Math.ceil((windowMs - (now - list[0])) / 1000);
  }
  list.push(now);
  buckets.set(key, list);
  return 0;
}

/**
 * Express middleware allowing `max` requests per `windowMs`, keyed by the
 * logged-in user when there is one, otherwise by IP.
 */
export function limit(name, max, windowMs) {
  return (req, res, next) => {
    const who = req.user ? `u${req.user.id}` : `ip${req.ip}`;
    const retryAfter = hit(`${name}:${who}`, max, windowMs);
    if (!retryAfter) return next();
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests. Please wait a little and try again.' });
  };
}

// Forget old keys now and then so memory stays flat.
setInterval(() => {
  const now = Date.now();
  for (const [key, list] of buckets) if (!list.length || now - list[list.length - 1] > 3_600_000) buckets.delete(key);
}, 600_000).unref();

const MIN = 60_000;
const HOUR = 60 * MIN;
export const limits = {
  signup: limit('signup', 10, HOUR),
  login: limit('login', 30, 10 * MIN),
  usernames: limit('usernames', 120, HOUR),
  trends: limit('trends', 30, HOUR),
  script: limit('script', 30, HOUR),
  frameCheck: limit('frame', 120, HOUR),
  transcribe: limit('transcribe', 60, HOUR),
  tts: limit('tts', 400, HOUR),
  takes: limit('takes', 80, HOUR),
  reels: limit('reels', 12, HOUR),
};
