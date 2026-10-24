import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { requireUser } from './auth.js';

// Free and Pro plans, paid through Razorpay Checkout or Pine Labs Online
// (Plural) hosted checkout. Razorpay is used when its keys are set.
// Pro is a 30-day pass (₹299); paying again extends it. Auto-renewing
// subscriptions need Pine Labs' UPI Autopay/mandates, a separate integration.

export const PLANS = {
  free: { reelsPerMonth: 3, maxLongEdge: 1280, tag: true },
  pro: { reelsPerMonth: Infinity, maxLongEdge: 1920, tag: false },
};
const PRO_DAYS = 30;

const BASE = config.pinelabsEnv === 'production' ? 'https://api.pluralpay.in' : 'https://pluraluat.v2.pinepg.in';
const baseUrl = () => config.pinelabsBaseUrl || BASE;
const razorpayConfigured = Boolean(config.razorpayKeyId && config.razorpayKeySecret);
const pinelabsConfigured = Boolean(config.pinelabsClientId && config.pinelabsClientSecret && config.publicUrl);
const pageConfigured = Boolean(config.razorpayPaymentPageUrl && config.razorpayWebhookSecret);
const liveKeys = razorpayConfigured && config.razorpayKeyId.startsWith('rzp_live_');
// Live API keys first; then the Payment Page (real money without API keys);
// then test keys; then Pine Labs.
export const paymentProvider = liveKeys
  ? 'razorpay'
  : pageConfigured
    ? 'razorpay_page'
    : razorpayConfigured
      ? 'razorpay'
      : pinelabsConfigured
        ? 'pinelabs'
        : null;
export const paymentsConfigured = Boolean(paymentProvider);

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

/**
 * Makes sure everyone with a paid Pro payment actually has Pro: at least 30
 * days from their latest payment. Safe to run any number of times.
 */
export async function reconcilePro() {
  const { rowCount } = await pool.query(
    `UPDATE users u SET pro_until = p.paid_until
     FROM (SELECT user_id, max(coalesce(paid_at, created_at)) + make_interval(days => $1) AS paid_until
           FROM payments WHERE status = 'paid' GROUP BY user_id) p
     WHERE u.id = p.user_id AND (u.pro_until IS NULL OR u.pro_until < p.paid_until)`,
    [PRO_DAYS],
  );
  if (rowCount) console.log(`Pro switched on for ${rowCount} creator(s) with paid payments`);
  return rowCount;
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

/**
 * Asks the payment provider for the order's status and, if paid, grants Pro
 * (once). Every path (return, popup, webhook, sweeper) comes through here.
 */
export async function settle(reference) {
  const { rows } = await pool.query('SELECT * FROM payments WHERE merchant_order_reference = $1', [reference]);
  const payment = rows[0];
  if (!payment) return null;
  if (payment.status === 'paid') return 'paid';

  let status;
  let paid;
  let raw;
  if (payment.provider === 'razorpay') {
    const order = await razorpay(`/v1/orders/${encodeURIComponent(payment.pine_order_id)}`);
    status = String(order.status ?? '').toUpperCase(); // CREATED, ATTEMPTED, PAID
    paid = status === 'PAID' && Number(order.amount_paid ?? order.amount) === payment.amount_paise;
    raw = order;
  } else {
    const json = await pinelabs(`/api/pay/v1/orders/reference/${encodeURIComponent(reference)}`);
    raw = json.data ?? json;
    status = String(raw.status ?? '').toUpperCase();
    const amount = Number(raw.order_amount?.value);
    paid = config.pinelabsPaidStatuses.includes(status) && (!amount || amount === payment.amount_paise);
  }
  return record(reference, { paid, status, raw });
}

async function record(reference, { paid, status, raw }) {
  const order = raw;
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

// --- Razorpay ----------------------------------------------------------------

async function razorpay(path, { method = 'GET', body } = {}) {
  const auth = Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64');
  const res = await fetch(`${config.razorpayBaseUrl}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Razorpay error', method, path, res.status, JSON.stringify(json).slice(0, 500));
    throw new BillingError('Payments are unavailable right now');
  }
  return json;
}

const hmacHex = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');
const sameHex = (a, b) => {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Razorpay webhook: signed with the webhook secret over the raw body. */
async function razorpayWebhook(req, res) {
      const signature = req.get('x-razorpay-signature');
      if (!config.razorpayWebhookSecret || !signature || !sameHex(signature, hmacHex(config.razorpayWebhookSecret, req.body))) {
        return res.status(401).json({ error: 'Bad signature' });
      }
      try {
        const event = JSON.parse(req.body.toString('utf8'));
        const orderId = event.payload?.order?.entity?.id ?? event.payload?.payment?.entity?.order_id;
        let handled = false;
        if (orderId) {
          const { rows } = await pool.query("SELECT merchant_order_reference FROM payments WHERE provider = 'razorpay' AND pine_order_id = $1", [orderId]);
          if (rows[0]) {
            await settle(rows[0].merchant_order_reference);
            handled = true;
          }
        }
        // Not one of our API orders: a Payment Page payment, matched by the username field.
        if (!handled && event.event === 'payment.captured') await settlePagePayment(event.payload?.payment?.entity);
        res.json({ ok: true });
      } catch (err) {
        console.error('Razorpay webhook failed:', err.message);
        res.status(500).json({ error: 'Webhook failed' });
      }
}

/**
 * Grants Pro for a captured Payment Page payment. The page has a "Darpan
 * username" field; Razorpay passes form fields in the payment's notes.
 */
async function settlePagePayment(payment) {
  if (!payment?.id || payment.status !== 'captured') return;
  if (payment.currency !== 'INR' || Number(payment.amount) < config.proPricePaise) {
    console.error('Payment Page payment below the Pro price, not granting Pro:', payment.id, payment.amount);
    return;
  }
  const candidates = Object.values(payment.notes ?? {})
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim().replace(/^@/, '').toLowerCase());
  const { rows } = await pool.query('SELECT id FROM users WHERE username = ANY($1) LIMIT 1', [candidates]);
  if (!rows[0]) {
    console.error('Payment Page payment with no matching Darpan username:', payment.id, JSON.stringify(payment.notes));
    return;
  }
  // The payment ID is the reference, so a repeated webhook can't grant Pro twice.
  const { rowCount } = await pool.query(
    `INSERT INTO payments (user_id, merchant_order_reference, pine_order_id, amount_paise, status, provider, raw)
     VALUES ($1, $2, $3, $4, 'created', 'razorpay_page', $5) ON CONFLICT (merchant_order_reference) DO NOTHING`,
    [rows[0].id, payment.id, payment.order_id ?? null, Number(payment.amount), payment],
  );
  if (rowCount) await record(payment.id, { paid: true, status: 'CAPTURED', raw: payment });
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

webhookRouter.post('/api/billing/razorpay/webhook', express.raw({ type: '*/*', limit: '1mb' }), razorpayWebhook);

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
      provider: paymentProvider,
      username: req.user.username,
    });
  } catch (err) {
    next(err);
  }
});

billingRouter.post('/api/billing/checkout', requireUser, async (req, res, next) => {
  if (!paymentsConfigured) return res.status(503).json({ error: 'Payments are not set up yet' });
  if (paymentProvider === 'razorpay_page') {
    return res.json({ provider: 'razorpay_page', url: config.razorpayPaymentPageUrl, username: req.user.username });
  }
  if (paymentProvider === 'razorpay') {
    // Razorpay: create an order here; the app opens Razorpay Checkout with it.
    try {
      const reference = `darpan-${req.user.id}-${Date.now()}`;
      const order = await razorpay('/v1/orders', {
        method: 'POST',
        body: {
          amount: config.proPricePaise,
          currency: 'INR',
          receipt: reference,
          notes: { user_id: String(req.user.id), plan: `pro-${PRO_DAYS}d` },
        },
      });
      await pool.query(
        'INSERT INTO payments (user_id, merchant_order_reference, pine_order_id, amount_paise, status, provider) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.user.id, reference, order.id, config.proPricePaise, 'pending', 'razorpay'],
      );
      return res.json({
        provider: 'razorpay',
        keyId: config.razorpayKeyId,
        orderId: order.id,
        amount: config.proPricePaise,
        currency: 'INR',
        name: req.user.name,
      });
    } catch (err) {
      return next(err);
    }
  }
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

// Razorpay Checkout's success handler posts here; the signature proves the
// payment belongs to our order, then Razorpay's order API confirms it's paid.
billingRouter.post('/api/billing/razorpay/verify', requireUser, async (req, res, next) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body ?? {};
  if (!orderId || !paymentId || !signature) return res.status(400).json({ error: 'Missing payment details' });
  if (!sameHex(signature, hmacHex(config.razorpayKeySecret, `${orderId}|${paymentId}`))) {
    return res.status(400).json({ error: 'Payment could not be verified' });
  }
  try {
    const { rows } = await pool.query(
      "SELECT merchant_order_reference FROM payments WHERE provider = 'razorpay' AND pine_order_id = $1 AND user_id = $2",
      [orderId, req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    const outcome = await settle(rows[0].merchant_order_reference);
    res.json({ status: outcome === 'paid' ? 'success' : 'pending' });
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
