import os from 'node:os';
import path from 'node:path';

export const config = {
  port: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  deepgramBaseUrl: process.env.DEEPGRAM_BASE_URL || 'https://api.deepgram.com',
  sarvamApiKey: process.env.SARVAM_API_KEY,
  sarvamBaseUrl: process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai',
  // A Bulbul v3 voice; see Sarvam's docs for others (shubh, aditya, ritu, neha...).
  sarvamSpeaker: process.env.SARVAM_SPEAKER || 'priya',
  adminPassword: process.env.ADMIN_PASSWORD,
  // Razorpay (used for Pro when its keys are set).
  // Trimmed: a stray space or newline from copy-paste breaks Razorpay's login.
  razorpayKeyId: process.env.RAZORPAY_KEY_ID?.trim(),
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET?.trim(),
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET?.trim(),
  razorpayBaseUrl: process.env.RAZORPAY_BASE_URL || 'https://api.razorpay.com',
  // Pine Labs Online (Plural) payments for Pro.
  pinelabsClientId: process.env.PINELABS_CLIENT_ID,
  pinelabsClientSecret: process.env.PINELABS_CLIENT_SECRET,
  pinelabsWebhookSecret: process.env.PINELABS_WEBHOOK_SECRET,
  pinelabsEnv: process.env.PINELABS_ENV || 'uat',
  pinelabsBaseUrl: process.env.PINELABS_BASE_URL,
  // Order statuses that mean "paid"; confirm with Pine Labs for your account.
  pinelabsPaidStatuses: (process.env.PINELABS_PAID_STATUSES || 'PROCESSED').split(',').map((s) => s.trim().toUpperCase()),
  // Amount in paise (Rs 299 = 29900); confirm the unit with Pine Labs.
  proPricePaise: Number(process.env.PRO_PRICE_PAISE || 29900),
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),
  agenticorgApiKey: process.env.AGENTICORG_API_KEY,
  agenticorgDirectorAgentId: process.env.AGENTICORG_DIRECTOR_AGENT_ID,
  agenticorgBaseUrl: process.env.AGENTICORG_BASE_URL || 'https://app.agenticorg.ai',
  // Uploads are streamed to disk, never buffered in memory (the server has 512 MB).
  uploadDir: process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'darpan-uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024,
  staticDir: process.env.STATIC_DIR || path.resolve(import.meta.dirname, '../../app/dist'),
};
