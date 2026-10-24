import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { requireUser } from './auth.js';

// Free and Pro plans, paid through Pine Labs Online (Plural) hosted checkout.
// Pro is a 30-day pass (₹299); paying again extends it. Auto-renewing
// subscriptions need Pine Labs' UPI Autopay/mandates, a separate integration.

export const PLANS = {
  free: { reelsPerMonth: 3, maxLongEdge: 1280, tag: true },
  pro: { reelsPerMonth: Infinity, maxLongEdge: 1920, tag: false },
};
const PRO_DAYS = 30;

const BASE = config.pinelabsEnv === 'production' ? 'https://api.pluralpay.in' : 'https://pluraluat.v2.pinepg.in';
const baseUrl = () => config.pinelabsBaseUrl || BASE;
export const paymentsConfigured = Boolean(config.pinelabsClientId && config.pinelabsClientSecret && config.publicUrl);

export class BillingError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// --- Plan and usage ----------------------------------------------------------

export async function planFor(userId) {
  const { rows } = await pool.query(
    `SELECT pro_until, pro_until > now() AS is_pro,
            (SELECT count(*)::int FROM reels r
              WHERE r.user_id = u.id AND r.status <> 'error'
                AND r.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') AS reels_this_month
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  const plan = row?.is_pro ? 'pro' : 'free';
  return { plan, proUntil: row?.pro_until ?? null, reelsThisMonth: row?.reels_this_month ?? 0, ...PLANS[plan] };
}

// --- Pine Labs API -----------------------------------------------------------

let token = null; // { value, expiresAt }

async function accessToken() {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const res = await fetch(`${baseUrl()}/api/auth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.pinelabsClientId,
      client_secret: config.pinelabsClientSecret,
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error('Pine Labs token error', res.status, await res.text().catch(() => ''));
    throw new BillingError('Payments are unavailable right now');
  }
  const json = await res.json();
  token = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  return token.value;
}

async function pinelabs(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      'Request-ID': randomUUID(),
      'Request-Timestamp': new Date().toISOString(),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Pine Labs error', method, path, res.status, JSON.stringify(json).slice(0, 500));
    throw new BillingError('Payments are unavailable right now');
  }
  return json;
}

/** Asks Pine Labs for the order's status and, if paid, grants Pro (once). */
export async function settle(reference) {
  const { rows } = await pool.query('SELECT * FROM payments WHERE merchant_order_reference = $1', [reference]);
  const payment = rows[0];
  if (!payment) return null;
  if (payment.status === 'paid') return 'paid';

  const json = await pinelabs(`/api/pay/v1/orders/reference/${encodeURIComponent(reference)}`);
  const order = json.data ?? json;
  const status = String(order.status ?? '').toUpperCase();
  const amount = Number(order.order_amount?.value);
  const paid = config.pinelabsPaidStatuses.includes(status) && (!amount || amount === payment.amount_paise);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only the first caller to flip the row to 'paid' extends Pro.
    const { rows: updated } = await client.query(
      `UPDATE payments SET status = $2, pine_status = $3, raw = $4, paid_at = CASE WHEN $2 = 'paid' THEN now() END
       WHERE merchant_order_reference = $1 AND status <> 'paid' RETURNING user_id`,
      [reference, paid ? 'paid' : ['FAILED', 'CANCELLED'].includes(status) ? 'failed' : 'pending', status, order],
    );
    if (paid && updated[0]) {
      await client.query(
        `UPDATE users SET pro_until = GREATEST(COALESCE(pro_until, now()), now()) + make_interval(days => $2) WHERE id = $1`,
        [updated[0].user_id, PRO_DAYS],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return paid ? 'paid' : status;
}

function verifyWebhook(req) {
  const id = req.get('webhook-id');
  const timestamp = req.get('webhook-timestamp');
  const signatures = req.get('webhook-signature') ?? '';
  if (!id || !timestamp || !config.pinelabsWebhookSecret) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 600) return false;
  const key = Buffer.from(config.pinelabsWebhookSecret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${req.body.toString('utf8')}`).digest();
  return signatures.split(' ').some((part) => {
    const given = Buffer.from(part.replace(/^v1,/, ''), 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// --- Routes ------------------------------------------------------------------

/** Mounted before express.json(): the webhook signature covers the raw body. */
export const webhookRouter = express.Router();
webhookRouter.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!verifyWebhook(req)) return res.status(401).json({ error: 'Bad signature' });
  try {
    const event = JSON.parse(req.body.toString('utf8'));
    const reference = event.data?.merchant_order_reference ?? event.merchant_order_reference;
    if (reference) await settle(reference);
    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook handling failed:', err.message);
    res.status(500).json({ error: 'Webhook failed' });
  }
});

export const billingRouter = express.Router();

billingRouter.get('/api/billing', requireUser, async (req, res, next) => {
  try {
    const p = await planFor(req.user.id);
    res.json({
      plan: p.plan,
      proUntil: p.proUntil,
      reelsThisMonth: p.reelsThisMonth,
      reelsPerMonth: Number.isFinite(p.reelsPerMonth) ? p.reelsPerMonth : null,
      priceRupees: config.proPricePaise / 100,
      paymentsEnabled: paymentsConfigured,
    });
  } catch (err) {
    next(err);
  }
});

billingRouter.post('/api/billing/checkout', requireUser, async (req, res, next) => {
  if (!paymentsConfigured) return res.status(503).json({ error: 'Payments are not set up yet' });
  try {
    const reference = `darpan-${req.user.id}-${Date.now()}`;
    await pool.query(
      'INSERT INTO payments (user_id, merchant_order_reference, amount_paise, status) VALUES ($1, $2, $3, $4)',
      [req.user.id, reference, config.proPricePaise, 'created'],
    );
    const order = await pinelabs('/api/checkout/v1/orders', {
      method: 'POST',
      body: {
        merchant_order_reference: reference,
        order_amount: { value: config.proPricePaise, currency: 'INR' },
        integration_mode: 'REDIRECT',
        notes: `Darpan Pro, ${PRO_DAYS} days`,
        // The session cookie isn't sent on Pine Labs' cross-site return, so the
        // reference travels in the URL and is checked with Pine Labs directly.
        callback_url: `${config.publicUrl}/api/billing/return?ref=${encodeURIComponent(reference)}`,
        purchase_details: { customer: { customer_id: String(req.user.id), first_name: req.user.name.slice(0, 50) } },
      },
    });
    await pool.query('UPDATE payments SET pine_order_id = $2, status = $3 WHERE merchant_order_reference = $1', [
      reference,
      order.order_id ?? null,
      'pending',
    ]);
    if (!order.redirect_url) throw new BillingError('Payments are unavailable right now');
    res.json({ redirectUrl: order.redirect_url });
  } catch (err) {
    next(err);
  }
});

// Pine Labs sends the shopper back here (GET or POST) after paying.
billingRouter.all('/api/billing/return', express.urlencoded({ extended: false }), async (req, res) => {
  const reference = String(req.query.ref ?? '');
  let outcome = 'failed';
  try {
    if (reference) outcome = (await settle(reference)) === 'paid' ? 'success' : 'pending';
  } catch (err) {
    console.error('Payment return check failed:', err.message);
    outcome = 'pending';
  }
  res.redirect(303, `/?billing=${outcome}`);
});

// Pending payments whose webhook never arrived: re-check them now and then.
export function startPaymentSweeper() {
  if (!paymentsConfigured) return;
  setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT merchant_order_reference FROM payments
         WHERE status = 'pending' AND created_at > now() - interval '1 day' AND created_at < now() - interval '2 minutes'
         LIMIT 20`,
      );
      for (const r of rows) await settle(r.merchant_order_reference).catch(() => {});
    } catch {}
  }, 5 * 60_000).unref();
}
