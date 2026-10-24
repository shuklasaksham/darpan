import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { pool } from './db.js';
import { suggestUsernames, USERNAME_PATTERN } from './usernames.js';

const scryptAsync = promisify(scrypt);

const SESSION_COOKIE = 'darpan_session';
const SESSION_DAYS = 30;
const MAX_WRONG_PINS = 5;
const LOCK_MINUTES = 15;
export const GENDERS = ['woman', 'man', 'prefer_not_to_say'];

// PINs only have 10,000 possible values, so the lockout below is what really
// protects accounts; scrypt just keeps a leaked table from being read at a glance.
async function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pin, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPin(pin, stored) {
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(pin, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

const LOCK_SECONDS_SQL = 'COALESCE(EXTRACT(EPOCH FROM locked_until - now()), 0)::float8';

// Spent on unknown usernames so they take as long as wrong PINs.
const DUMMY_HASH = await hashPin('0000');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

async function startSession(res, userId) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS],
  );
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_DAYS * 86_400_000 });
}

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, gender: u.gender, niche: u.niche });

/** Sets req.user when the request carries a valid session cookie. */
export async function loadUser(req, _res, next) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !pool) return next();
  try {
    const { rows } = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (rows[0]) req.user = publicUser(rows[0]);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  next();
}

function requireDb(_req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Accounts need a database' });
  next();
}

const isPin = (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin);
const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export const authRouter = express.Router();
authRouter.use(requireDb);

authRouter.get('/me', (req, res) => res.json({ user: req.user ?? null }));

authRouter.post('/username-suggestions', async (req, res, next) => {
  const name = cleanText(req.body?.name, 60);
  if (!name) return res.status(400).json({ error: 'Tell us your name first' });
  try {
    const candidates = suggestUsernames(name);
    const { rows } = await pool.query('SELECT username FROM users WHERE username = ANY($1)', [candidates]);
    const taken = new Set(rows.map((r) => r.username));
    res.json({ suggestions: candidates.filter((c) => !taken.has(c)).slice(0, 5) });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/signup', async (req, res, next) => {
  const name = cleanText(req.body?.name, 60);
  const niche = cleanText(req.body?.niche, 200);
  const gender = req.body?.gender;
  const username = cleanText(req.body?.username, 30).toLowerCase();
  const { pin, pinConfirm } = req.body ?? {};

  if (!name) return res.status(400).json({ error: 'Tell us your name' });
  if (!GENDERS.includes(gender)) return res.status(400).json({ error: 'Pick a gender option' });
  if (!niche) return res.status(400).json({ error: 'Tell us your niche' });
  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({
      error: 'Usernames are 3–20 lowercase letters, numbers, dots or underscores',
    });
  }
  if (!isPin(pin)) return res.status(400).json({ error: 'Your PIN must be exactly 4 digits' });
  if (pin !== pinConfirm) return res.status(400).json({ error: "The two PINs don't match" });

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, name, gender, niche, pin_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO NOTHING
       RETURNING *`,
      [username, name, gender, niche, await hashPin(pin)],
    );
    if (!rows[0]) return res.status(409).json({ error: 'That username was just taken. Pick another.' });
    await startSession(res, rows[0].id);
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  const username = cleanText(req.body?.username, 30).toLowerCase();
  const { pin } = req.body ?? {};
  const wrong = { error: 'Wrong username or PIN' };
  if (!username || !isPin(pin)) return res.status(400).json(wrong);

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // FOR UPDATE makes attempts on one account take turns, so a burst of
    // parallel guesses can't all be checked before the lock kicks in.
    // Lock times are compared in SQL so app and database clocks can't disagree.
    const { rows } = await client.query(
      `SELECT *, ${LOCK_SECONDS_SQL} AS lock_seconds FROM users WHERE username = $1 FOR UPDATE`,
      [username],
    );
    const user = rows[0];
    if (!user) {
      await client.query('COMMIT');
      await verifyPin(pin, DUMMY_HASH);
      return res.status(401).json(wrong);
    }
    if (user.lock_seconds > 0) {
      await client.query('COMMIT');
      return res.status(423).json(lockedError(user.lock_seconds));
    }

    if (await verifyPin(pin, user.pin_hash)) {
      await client.query('UPDATE users SET failed_pins = 0, locked_until = NULL WHERE id = $1', [user.id]);
      await client.query('COMMIT');
      await startSession(res, user.id);
      return res.json({ user: publicUser(user) });
    }

    // Hitting the limit locks the account and starts a fresh count for afterwards.
    const { rows: [after] } = await client.query(
      `UPDATE users SET
         locked_until = CASE WHEN failed_pins + 1 >= $2
                             THEN now() + make_interval(mins => $3) ELSE locked_until END,
         failed_pins = CASE WHEN failed_pins + 1 >= $2 THEN 0 ELSE failed_pins + 1 END
       WHERE id = $1
       RETURNING failed_pins, ${LOCK_SECONDS_SQL} AS lock_seconds`,
      [user.id, MAX_WRONG_PINS, LOCK_MINUTES],
    );
    await client.query('COMMIT');
    if (after.lock_seconds > 0) return res.status(423).json(lockedError(after.lock_seconds));
    res.status(401).json({ ...wrong, attemptsLeft: MAX_WRONG_PINS - after.failed_pins });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function lockedError(lockSeconds) {
  const minutes = Math.max(1, Math.ceil(lockSeconds / 60));
  return {
    error: `Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    retryAfterSeconds: Math.ceil(lockSeconds),
  };
}
