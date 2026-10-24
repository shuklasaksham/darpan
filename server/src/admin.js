import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { limit } from './limits.js';
import { claudeConfigured } from './claude.js';
import { directorConfigured } from './director.js';
import { ttsConfigured } from './tts.js';
import { paymentProvider, paymentsConfigured } from './billing.js';

// Owner dashboard at /admin. Signed in with ADMIN_PASSWORD (set in Render),
// separate from creator accounts; the session is a signed, httpOnly cookie.

const COOKIE = 'darpan_admin';
// The team's own accounts: kept out of totals and listed separately.
const DEV_FIRST_NAMES = ['saksham', 'tanay', 'abhinav'];
const DEV = `(is_dev OR lower(split_part(trim(name), ' ', 1)) = ANY('{${DEV_FIRST_NAMES.join(',')}}'))`;
const SESSION_MS = 12 * 60 * 60 * 1000;
export const adminConfigured = Boolean(config.adminPassword && config.adminPassword.length >= 12);

const sign = (value) => createHmac('sha256', `darpan-admin:${config.adminPassword}`).update(value).digest('base64url');

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function isAdmin(req) {
  if (!adminConfigured) return false;
  const [expires, mac] = (readCookie(req) ?? '').split('.');
  return Boolean(expires && mac && Number(expires) > Date.now() && sameText(mac, sign(expires)));
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  path: '/api/admin',
});

export const adminRouter = express.Router();

adminRouter.post('/api/admin/login', limit('admin-login', 10, 15 * 60_000), (req, res) => {
  if (!adminConfigured) return res.status(503).json({ error: 'Set ADMIN_PASSWORD (12+ characters) in Render first' });
  if (!sameText(req.body?.password ?? '', config.adminPassword)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const expires = String(Date.now() + SESSION_MS);
  res.cookie(COOKIE, `${expires}.${sign(expires)}`, { ...cookieOptions(), maxAge: SESSION_MS });
  res.json({ ok: true });
});

adminRouter.post('/api/admin/logout', (_req, res) => {
  res.clearCookie(COOKIE, cookieOptions());
  res.json({ ok: true });
});

adminRouter.get('/api/admin/stats', async (req, res, next) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Please sign in' });
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    const one = async (sql) => (await pool.query(sql)).rows[0];
    const all = async (sql) => (await pool.query(sql)).rows;
    const [totals, daily, users, payments, reels, takes] = await Promise.all([
      one(`SELECT
        (SELECT count(*)::int FROM users WHERE NOT ${DEV}) AS users,
        (SELECT count(*)::int FROM users WHERE ${DEV}) AS dev_users,
        (SELECT count(*)::int FROM users WHERE NOT ${DEV} AND created_at > now() - interval '7 days') AS users_7d,
        (SELECT count(*)::int FROM users WHERE NOT ${DEV} AND pro_until > now()) AS pro_users,
        (SELECT count(*)::int FROM shoot_plans) AS scripts,
        (SELECT count(*)::int FROM shoot_plans WHERE created_at > now() - interval '7 days') AS scripts_7d,
        (SELECT count(*)::int FROM takes) AS takes,
        (SELECT round(avg(score))::int FROM takes WHERE score IS NOT NULL) AS avg_score,
        (SELECT count(*)::int FROM reels WHERE status = 'done') AS reels,
        (SELECT count(*)::int FROM reels WHERE status = 'error') AS reels_failed,
        (SELECT coalesce(sum(amount_paise), 0)::bigint FROM payments WHERE status = 'paid') AS revenue_paise,
        (SELECT coalesce(sum(amount_paise), 0)::bigint FROM payments WHERE status = 'paid' AND paid_at > date_trunc('month', now())) AS revenue_month_paise,
        (SELECT count(DISTINCT t.user_id)::int FROM takes t JOIN users u ON u.id = t.user_id WHERE NOT ${DEV.replaceAll('is_dev', 'u.is_dev').replaceAll('name)', 'u.name)')} AND t.created_at > now() - interval '7 days') AS active_7d`),
      all(`SELECT to_char(d, 'DD Mon') AS day,
          (SELECT count(*)::int FROM users WHERE created_at::date = d) AS signups,
          (SELECT count(*)::int FROM takes WHERE created_at::date = d) AS takes,
          (SELECT count(*)::int FROM reels WHERE created_at::date = d AND status = 'done') AS reels
        FROM generate_series(current_date - 13, current_date, interval '1 day') AS d ORDER BY d`),
      all(`SELECT u.id, u.username, u.name, u.niche, u.gender, u.created_at, u.pro_until > now() AS pro,
          u.pro_until, ${DEV.replaceAll('is_dev', 'u.is_dev').replaceAll('name)', 'u.name)')} AS is_dev, u.pro_complimentary,
          (SELECT count(*)::int FROM takes t WHERE t.user_id = u.id) AS takes,
          (SELECT count(*)::int FROM reels r WHERE r.user_id = u.id AND r.status = 'done') AS reels
        FROM users u ORDER BY u.created_at DESC LIMIT 100`),
      all(`SELECT p.created_at, u.username, p.amount_paise, p.status, p.pine_status, p.merchant_order_reference
        FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 30`),
      all(`SELECT r.id, r.created_at, u.username, r.status, r.error, r.duration_seconds, r.width, r.height
        FROM reels r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 30`),
      all(`SELECT t.created_at, u.username, t.score, t.notes_source, t.duration_seconds
        FROM takes t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 30`),
    ]);
    res.json({
      totals,
      daily,
      users,
      payments,
      reels,
      takes,
      services: {
        database: true,
        claude: claudeConfigured,
        agenticorg: directorConfigured,
        deepgram: Boolean(config.deepgramApiKey),
        sarvam: ttsConfigured,
        payments: paymentsConfigured,
        paymentProvider: paymentProvider ?? 'none',
      },
    });
  } catch (err) {
    next(err);
  }
});
