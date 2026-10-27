import express from 'express';
import webpush from 'web-push';
import { config } from './config.js';
import { pool } from './db.js';
import { trendCards } from './claude.js';

// Days are counted in India time: a reel made at 11 pm in Indore counts for that day.
const ZONE = 'Asia/Kolkata';
const REMINDER_HOUR = 9; // when the daily idea goes out, India time

/** Today's date in India, as YYYY-MM-DD. */
const indiaDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: ZONE });
const indiaHour = () => Number(new Date().toLocaleString('en-GB', { timeZone: ZONE, hour: '2-digit', hour12: false }));
const dayNumber = (ymd) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);

/**
 * One of the creator's trend ideas for today: the same all day, a different one
 * tomorrow. Uses the cached trend cards, so it's quick.
 */
export async function dailyIdea(user, language) {
  const cards = await trendCards({ niche: user.niche, language });
  if (!cards?.length) return null;
  const today = dayNumber(indiaDate());
  // Offset by user, so creators in the same niche don't all get the same idea.
  return cards[(today + Number(user.id)) % cards.length];
}

/**
 * Days in a row (India time) on which the creator finished a reel. The streak
 * is still alive if their last reel was yesterday; `today` says whether today
 * already counts.
 */
export async function streakFor(userId) {
  if (!pool) return { current: 0, best: 0, today: false };
  const { rows } = await pool.query(
    `SELECT DISTINCT (created_at AT TIME ZONE '${ZONE}')::date::text AS day
       FROM reels WHERE user_id = $1 AND status = 'done' ORDER BY day DESC LIMIT 400`,
    [userId],
  );
  const days = rows.map((r) => dayNumber(r.day));
  const today = dayNumber(indiaDate());
  let best = 0;
  let run = 0;
  days.forEach((d, i) => {
    run = i > 0 && days[i - 1] - d === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  });
  let current = 0;
  if (days[0] === today || days[0] === today - 1) {
    current = 1;
    while (current < days.length && days[current - 1] - days[current] === 1) current++;
  }
  return { current, best, today: days[0] === today };
}

// --- Daily reminder notifications -------------------------------------------

/**
 * VAPID keys identify Darpan to the phones' push services. They're made once
 * and kept in Postgres, so there's nothing to configure and they survive deploys.
 */
let vapidPromise;
function vapidKeys() {
  vapidPromise ??= (async () => {
    if (!pool) return null;
    const { rows: [saved] } = await pool.query(`SELECT value FROM app_settings WHERE key = 'vapid'`);
    let keys = saved?.value;
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [keys]);
      ({ rows: [{ value: keys }] } = await pool.query(`SELECT value FROM app_settings WHERE key = 'vapid'`));
    }
    webpush.setVapidDetails(config.publicUrl || 'https://www.darpan-ai.com', keys.publicKey, keys.privateKey);
    return keys;
  })().catch((err) => {
    vapidPromise = null;
    throw err;
  });
  return vapidPromise;
}

export const pushRouter = express.Router();

pushRouter.get('/key', async (_req, res, next) => {
  try {
    const keys = await vapidKeys();
    if (!keys) return res.status(503).json({ error: 'Reminders need a database' });
    res.json({ publicKey: keys.publicKey });
  } catch (err) {
    next(err);
  }
});

pushRouter.post('/subscribe', async (req, res, next) => {
  const sub = req.body?.subscription;
  const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint : '';
  if (!/^https:\/\//.test(endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ error: 'That notification subscription looks wrong' });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, user_id, keys, language) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys, language = EXCLUDED.language`,
      [endpoint.slice(0, 1000), req.user.id, { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, String(req.body.language ?? 'Hinglish').slice(0, 20)],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

pushRouter.post('/unsubscribe', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [String(req.body?.endpoint ?? ''), req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Sends today's idea to every phone that hasn't had it yet, once it's past 9 am in India. */
async function sendDueReminders() {
  if (!pool || indiaHour() < REMINDER_HOUR || indiaHour() >= 22) return;
  if (!(await vapidKeys())) return;
  const today = indiaDate();
  const { rows } = await pool.query(
    `SELECT s.endpoint, s.keys, s.language, u.id, u.niche FROM push_subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.last_sent_on IS DISTINCT FROM $1::date LIMIT 200`,
    [today],
  );
  for (const row of rows) {
    // Marked first, so a crash halfway never sends anyone two reminders.
    await pool.query('UPDATE push_subscriptions SET last_sent_on = $2::date WHERE endpoint = $1', [row.endpoint, today]);
    try {
      const [idea, streak] = await Promise.all([dailyIdea(row, row.language).catch(() => null), streakFor(row.id)]);
      const body = idea?.title ?? 'Your idea for today is ready. Shoot one short reel.';
      const title = streak.current > 0 ? `Day ${streak.current + 1}: today’s reel idea` : 'Today’s reel idea';
      await webpush.sendNotification({ endpoint: row.endpoint, keys: row.keys }, JSON.stringify({ title, body, url: '/' }), { TTL: 6 * 3600 });
    } catch (err) {
      // 404 and 410: the phone unsubscribed or the app was removed.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [row.endpoint]).catch(() => {});
      } else {
        console.error('Daily reminder failed:', err.statusCode ?? '', err.message);
      }
    }
  }
}

/** Checks every 10 minutes whether today's reminders are due. */
export function startDailyReminders() {
  const tick = () => sendDueReminders().catch((err) => console.error('Daily reminders failed:', err.message));
  tick();
  setInterval(tick, 10 * 60 * 1000).unref();
}
