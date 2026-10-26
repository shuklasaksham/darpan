import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import compression from 'compression';
import multer from 'multer';
import { config } from './config.js';
import { pool, migrate } from './db.js';
import { extractAudio, extractPoster, extractStrip, probe, ffmpegAvailable } from './ffmpeg.js';
import { analyzeTake, findFillers, ruleNotes } from './analyze.js';
import { enqueueReel, jobStatus, sweepOldFiles, takesDir, toHinglish, trimFor } from './reels.js';
import { authRouter, loadUser, requireUser } from './auth.js';
import { transcribeFile, transcribeWithWords, TranscribeError } from './transcribe.js';
import { checkFrame, ClaudeError, claudeConfigured, directorNotes, trendCards, writeScript } from './claude.js';
import { speak, TtsError, ttsConfigured } from './tts.js';
import { limits } from './limits.js';
import { adminRouter } from './admin.js';
import { billingRouter, BillingError, planFor, reconcilePro, startPaymentSweeper, webhookRouter } from './billing.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

// Uploads are streamed to disk, never buffered in memory (the server has 512 MB).
const diskStorage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (_req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname || '')),
});
const videoUpload = multer({ storage: diskStorage, limits: { fileSize: config.maxUploadBytes, files: 1 } });
const audioUpload = multer({ storage: diskStorage, limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

const app = express();
app.disable('x-powered-by');
// Render terminates HTTPS in front of the app; trust it for req.ip and req.secure.
app.set('trust proxy', 1);
app.use(compression());

// MediaPipe needs WebAssembly ('wasm-unsafe-eval') and blob: workers; recordings
// and reels play from blob: URLs; React sets some inline styles.
const CSP = [
  "default-src 'self'",
  // Razorpay Checkout loads its script and opens in an iframe.
  "script-src 'self' 'wasm-unsafe-eval' https://checkout.razorpay.com",
  "frame-src https://*.razorpay.com",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data: https://*.razorpay.com",
  "img-src 'self' blob: data: https://*.razorpay.com",
  "media-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  // Razorpay submits card/netbanking forms from this page into its bank popup.
  "form-action 'self' https://*.razorpay.com",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(self), screen-wake-lock=(self), geolocation=()',
    // allow-popups: Razorpay opens card/netbanking steps in a popup that must talk back.
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  });
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(webhookRouter); // needs the raw body, so before express.json()
app.use(express.json({ limit: '1mb' }));
app.use('/api', loadUser);

app.get('/api/health', async (_req, res) => {
  let db = false;
  if (pool) {
    try {
      await pool.query('SELECT 1');
      db = true;
    } catch {}
  }
  res.json({
    ok: true,
    db,
    ffmpeg: await ffmpegAvailable(),
    // 'persistent' when takes live on the Render Disk and survive redeploys.
    storage: config.uploadDir.startsWith('/var/data') ? 'persistent' : 'temporary',
    scripts: claudeConfigured,
    voice: Boolean(config.deepgramApiKey),
    tts: ttsConfigured,
    keys: {
      anthropic: Boolean(config.anthropicApiKey),
      deepgram: Boolean(config.deepgramApiKey),
      sarvam: Boolean(config.sarvamApiKey),
    },
  });
});

app.use('/api/auth', authRouter);
app.use(billingRouter);
app.use(adminRouter);

app.post('/api/transcribe', requireUser, limits.transcribe, audioUpload.single('audio'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Send audio in the "audio" field' });
  try {
    const transcript = await transcribeFile(req.file.path, req.file.mimetype, req.body.language);
    res.json({ transcript });
  } catch (err) {
    next(err);
  } finally {
    fs.promises.rm(req.file.path, { force: true });
  }
});

async function loadPlan(planId, userId) {
  if (!pool || !planId) return null;
  const { rows } = await pool.query('SELECT plan FROM shoot_plans WHERE id = $1 AND user_id = $2', [
    planId,
    userId,
  ]);
  return rows[0]?.plan ?? null;
}

app.get('/api/trends', requireUser, limits.trends, async (req, res, next) => {
  try {
    res.json({ cards: await trendCards({ niche: req.user.niche, language: req.query.language }) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/script', requireUser, limits.script, async (req, res, next) => {
  const { idea, format, language } = req.body ?? {};
  const cleanIdea = typeof idea === 'string' ? idea.trim() : '';
  if (cleanIdea.length > 1000) return res.status(400).json({ error: 'Keep your idea under 1000 characters' });
  if (!cleanIdea && !format) return res.status(400).json({ error: 'Tell Darpan your idea or pick a format' });
  try {
    const brief = {
      idea: cleanIdea || undefined,
      format: typeof format === 'string' ? format.slice(0, 60) : undefined,
      language,
    };
    const { script, messageId } = await writeScript({ creator: req.user, ...brief });
    let planId = null;
    if (pool) {
      const { rows } = await pool.query(
        'INSERT INTO shoot_plans (user_id, brief, plan, agent_run_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [req.user.id, brief, script, messageId],
      );
      planId = rows[0].id;
    }
    res.json({ planId, script });
  } catch (err) {
    next(err);
  }
});

// One Claude look at a frame per user every few seconds at most.
const FRAME_CHECK_GAP_MS = 4000;
const lastFrameCheck = new Map();

// Recent shoots with their kept takes, so a creator can pick up where they left off.
app.get('/api/recent', requireUser, async (req, res, next) => {
  if (!pool) return res.json({ shoots: [] });
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.created_at, p.brief, p.plan,
         coalesce((SELECT json_agg(json_build_object('id', t.id, 'shotIndex', t.shot_index, 'score', t.score,
                                                     'available', t.file_path IS NOT NULL) ORDER BY t.shot_index)
                   FROM takes t WHERE t.plan_id = p.id AND t.kept), '[]') AS kept,
         (SELECT json_build_object('id', r.id, 'status', r.status, 'durationSeconds', r.duration_seconds) FROM reels r
           WHERE r.plan_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS reel
       FROM shoot_plans p WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT 12`,
      [req.user.id],
    );
    // file_path survives a redeploy even when the file doesn't; check the disk.
    const { rows: paths } = await pool.query('SELECT id, file_path FROM takes WHERE user_id = $1 AND kept AND file_path IS NOT NULL', [req.user.id]);
    const present = new Set();
    for (const t of paths) if (await fileExists(t.file_path)) present.add(Number(t.id));
    res.json({
      shoots: rows.map((r) => ({
        planId: Number(r.id),
        createdAt: r.created_at,
        brief: r.brief,
        script: r.plan,
        kept: r.kept.map((k) => ({ ...k, available: present.has(Number(k.id)) })),
        reel: r.reel,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Save the creator's edits to a script before shooting.
app.put('/api/plans/:id', requireUser, async (req, res, next) => {
  const shots = req.body?.script?.shots;
  if (!pool) return res.status(503).json({ error: 'Saving scripts needs a database' });
  if (!Array.isArray(shots) || shots.length < 1 || shots.length > 6) {
    return res.status(400).json({ error: 'A script needs 1 to 6 shots' });
  }
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const FRAMINGS = ['closeup', 'medium', 'waist_up', 'full_body'];
  try {
    const plan = await loadPlan(req.params.id, req.user.id);
    if (!plan) return res.status(404).json({ error: 'Script not found' });
    const cleaned = {
      ...plan,
      title: text(req.body.script.title, 120) || plan.title,
      shots: shots.map((s, i) => ({
        ...(plan.shots?.[i] ?? {}),
        title: text(s.title, 60) || `Shot ${i + 1}`,
        line: text(s.line, 400),
        direction: text(s.direction, 200),
        framing: FRAMINGS.includes(s.framing) ? s.framing : 'medium',
        pose: typeof s.pose === 'string' ? s.pose : 'neutral',
        duration_seconds: Math.min(90, Math.max(1, Number(s.duration_seconds) || 5)),
      })),
    };
    await pool.query('UPDATE shoot_plans SET plan = $3 WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id, cleaned]);
    res.json({ planId: Number(req.params.id), script: cleaned });
  } catch (err) {
    next(err);
  }
});

app.post('/api/frame-check', requireUser, limits.frameCheck, async (req, res, next) => {
  const { image, planId, shotIndex, metrics, language } = req.body ?? {};
  const imageBase64 = typeof image === 'string' ? image.replace(/^data:image\/jpeg;base64,/, '') : '';
  if (!imageBase64 || imageBase64.length > 700_000) {
    return res.status(400).json({ error: 'Send one JPEG frame under 500 KB' });
  }
  const now = Date.now();
  if (now - (lastFrameCheck.get(req.user.id) ?? 0) < FRAME_CHECK_GAP_MS) {
    return res.status(429).json({ error: 'Too many frame checks' });
  }
  lastFrameCheck.set(req.user.id, now);
  try {
    const script = await loadPlan(planId, req.user.id);
    const shot = script?.shots?.[Number(shotIndex)] ?? null;
    res.json(await checkFrame({ imageBase64, shot, script, metrics, language: language ?? script?.language }));
  } catch (err) {
    next(err);
  }
});

app.post('/api/tts', requireUser, limits.tts, async (req, res, next) => {
  const { text, languageCode } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim() || text.length > 300) {
    return res.status(400).json({ error: 'Send up to 300 characters of text' });
  }
  try {
    const audio = await speak(text.trim(), languageCode);
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' }).send(audio);
  } catch (err) {
    next(err);
  }
});

/** [[seconds, value], ...] from a form field, capped and validated. */
function samples(text, max = 3000) {
  const parsed = safeJson(text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .slice(0, max)
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

function jpegFrames(text) {
  const parsed = safeJson(text);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x) => typeof x === 'string')
    .map((x) => x.replace(/^data:image\/jpeg;base64,/, ''))
    .filter((x) => x.length > 0 && x.length < 200_000)
    .slice(0, 3);
}

// After each take: transcribe it (fillers kept), measure it, and write up to
// three director's notes, with Claude when available and simple rules otherwise.
app.post('/api/takes', requireUser, limits.takes, videoUpload.single('video'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Send a video in the "video" field' });
  const audioPath = `${req.file.path}.wav`;
  let stored = false;
  try {
    const meta = await probe(req.file.path).catch(() => null);
    if (!meta) return res.status(422).json({ error: "Couldn't read that file as a video" });
    // Browser recordings (WebM) often carry no duration header; fall back to the recorder's timer.
    meta.durationSeconds ??= Number(req.body.durationSeconds) || null;

    const planId = Number(req.body.planId) || null;
    const shotIndex = req.body.shotIndex === undefined ? null : Number(req.body.shotIndex);
    const script = (await loadPlan(planId, req.user.id)) ?? safeJson(req.body.plan);
    const shot = shotIndex !== null ? (script?.shots?.[shotIndex] ?? null) : null;
    const language = script?.language ?? req.body.language ?? 'Hinglish';

    let transcript = '';
    let words = null;
    if (config.deepgramApiKey && meta.hasAudio) {
      try {
        await extractAudio(req.file.path, audioPath);
        ({ transcript, words } = await transcribeWithWords(audioPath, 'audio/wav', language, { keepFillers: true }));
      } catch (err) {
        console.error('Take transcription failed:', err.message);
      }
    }

    const analysis = analyzeTake({
      words,
      duration: meta.durationSeconds ?? 0,
      loudness: samples(req.body.loudness),
      gaze: samples(req.body.gaze),
      plannedSeconds: Number(shot?.duration_seconds) || null,
    });

    let director = { score: analysis.score, notes: ruleNotes(analysis, language), praise: '', source: 'rules' };
    if (claudeConfigured) {
      try {
        const notes = await directorNotes({
          shot,
          transcript,
          words: words ?? [],
          analysis,
          frames: jpegFrames(req.body.frames),
          language,
        });
        director = { ...notes, source: 'claude' };
      } catch (err) {
        console.error('Claude notes failed, using rules:', err.message);
      }
    }

    let id = null;
    if (pool) {
      const { rows } = await pool.query(
        `INSERT INTO takes (user_id, original_name, size_bytes, duration_seconds, width, height, plan_id, shot_index,
                            transcript, score, notes, features, notes_source, words, has_audio)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [
          req.user.id,
          req.file.originalname,
          req.file.size,
          meta.durationSeconds,
          meta.width,
          meta.height,
          planId,
          shotIndex,
          words ? transcript : null,
          director.score,
          JSON.stringify(director.notes),
          analysis.features,
          director.source,
          words ? JSON.stringify(words) : null,
          meta.hasAudio,
        ],
      );
      id = rows[0].id;
      // Keep the file for the reel (deleted after a day, or when another take of the shot is kept).
      const filePath = path.join(takesDir, `${id}${path.extname(req.file.path) || '.webm'}`);
      await fs.promises.rename(req.file.path, filePath);
      await pool.query('UPDATE takes SET file_path = $2 WHERE id = $1', [id, filePath]);
      stored = true;
    }
    // Which take of this shot this is, and the best score so far ("Best of 3 takes").
    let takeNumber = 1;
    let bestScore = director.score;
    if (pool && id && planId && shotIndex !== null) {
      const { rows: [n] } = await pool.query(
        'SELECT count(*)::int AS n, max(score)::int AS best FROM takes WHERE user_id = $1 AND plan_id = $2 AND shot_index = $3',
        [req.user.id, planId, shotIndex],
      );
      takeNumber = n.n;
      bestScore = n.best ?? director.score;
    }
    res.json({
      id,
      takeNumber,
      bestScore,
      breakdown: analysis.features.breakdown,
      durationSeconds: meta.durationSeconds,
      width: meta.width,
      height: meta.height,
      transcript: words ? transcript : null,
      score: director.score,
      notes: director.notes,
      praise: director.praise,
      source: director.source,
      features: analysis.features,
    });
  } catch (err) {
    next(err);
  } finally {
    if (!stored) fs.promises.rm(req.file.path, { force: true });
    fs.promises.rm(audioPath, { force: true });
  }
});

async function ownTake(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT * FROM takes WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] ?? null;
}

const fileExists = (p) => (p ? fs.promises.access(p).then(() => true, () => false) : Promise.resolve(false));

// "Keep" a take: it becomes the shot's take for the reel. The shot's other
// takes stay on disk (until the daily sweep) so the creator can switch back.
app.post('/api/takes/:id/keep', requireUser, async (req, res, next) => {
  try {
    const take = await ownTake(req.params.id, req.user.id);
    if (!take) return res.status(404).json({ error: 'Take not found' });
    await pool.query(
      `UPDATE takes SET kept = (id = $4), edited_at = CASE WHEN id = $4 AND NOT kept THEN now() ELSE edited_at END
       WHERE user_id = $1 AND plan_id IS NOT DISTINCT FROM $2 AND shot_index IS NOT DISTINCT FROM $3`,
      [req.user.id, take.plan_id, take.shot_index, take.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Every take of a shoot, for the reel editor: pick another take, trim it, fix its captions.
app.get('/api/plans/:id/takes', requireUser, async (req, res, next) => {
  if (!pool) return res.json({ takes: [] });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM takes WHERE user_id = $1 AND plan_id = $2 AND shot_index IS NOT NULL ORDER BY shot_index, created_at',
      [req.user.id, req.params.id],
    );
    const numbers = new Map();
    const takes = [];
    for (const t of rows) {
      const n = (numbers.get(t.shot_index) ?? 0) + 1;
      numbers.set(t.shot_index, n);
      takes.push({ ...editableTake(t), takeNumber: n, available: await fileExists(t.file_path) });
    }
    res.json({ takes, reel: await latestReel(req.user.id, req.params.id, rows) });
  } catch (err) {
    next(err);
  }
});

/**
 * The shoot's last finished reel, so the creator can come back to it instead of
 * making it again. `stale` when a shot's kept take changed, or a kept take was
 * trimmed or re-captioned, after the reel was made.
 */
async function latestReel(userId, planId, takes) {
  const { rows: [reel] } = await pool.query(
    `SELECT * FROM reels WHERE user_id = $1 AND plan_id = $2 AND status = 'done' ORDER BY created_at DESC LIMIT 1`,
    [userId, planId],
  );
  if (!reel || !(await fileExists(reel.file_path))) return null;
  const takeIds = reel.take_ids.map(Number);
  const kept = takes.filter((t) => t.kept);
  const keptIds = new Set(kept.map((t) => Number(t.id)));
  const stale =
    keptIds.size !== takeIds.length ||
    takeIds.some((id) => !keptIds.has(id)) ||
    kept.some((t) => t.edited_at && new Date(t.edited_at) > new Date(reel.created_at));
  return {
    id: Number(reel.id),
    takeIds,
    captions: reel.captions,
    width: reel.width,
    height: reel.height,
    durationSeconds: reel.duration_seconds,
    createdAt: reel.created_at,
    stale,
  };
}

/** What the reel editor needs to know about a take. */
function editableTake(t) {
  const words = t.words ?? [];
  const fillers = new Set(findFillers(words).flatMap((f) => f.indices));
  const trim = trimFor(t);
  return {
    id: Number(t.id),
    shotIndex: t.shot_index,
    kept: t.kept,
    score: t.score,
    breakdown: t.features?.breakdown ?? null,
    durationSeconds: t.duration_seconds,
    trim: { start: trim.start, end: trim.end, edited: t.trim_start != null },
    captionEdits: t.caption_edits ?? {},
    words: words.map((w, i) => ({ text: toHinglish(w.text), start: w.start, end: w.end, filler: fillers.has(i) })),
  };
}

// Save a take's trim and caption fixes. trimStart/trimEnd null resets to the automatic trim.
app.patch('/api/takes/:id', requireUser, async (req, res, next) => {
  try {
    const take = await ownTake(req.params.id, req.user.id);
    if (!take) return res.status(404).json({ error: 'Take not found' });
    const body = req.body ?? {};
    let { trim_start: start, trim_end: end, caption_edits: edits } = take;
    if ('trimStart' in body || 'trimEnd' in body) {
      if (body.trimStart == null || body.trimEnd == null) {
        start = end = null;
      } else {
        const duration = take.duration_seconds ?? Infinity;
        start = Math.max(0, Number(body.trimStart));
        end = Math.min(duration, Number(body.trimEnd));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.5) {
          return res.status(400).json({ error: 'Keep at least half a second of the take' });
        }
      }
    }
    if ('captionEdits' in body) {
      const count = (take.words ?? []).length;
      edits = {};
      for (const [k, v] of Object.entries(body.captionEdits ?? {})) {
        const i = Number(k);
        if (Number.isInteger(i) && i >= 0 && i < count && typeof v === 'string') edits[i] = v.trim().slice(0, 40);
      }
    }
    const { rows: [updated] } = await pool.query(
      'UPDATE takes SET trim_start = $2, trim_end = $3, caption_edits = $4, edited_at = now() WHERE id = $1 RETURNING *',
      [take.id, start, end, edits && Object.keys(edits).length ? JSON.stringify(edits) : null],
    );
    res.json({ take: { ...editableTake(updated), available: await fileExists(updated.file_path) } });
  } catch (err) {
    next(err);
  }
});

// Thumbnails, made with ffmpeg on first request and kept next to the take.
async function takeImage(req, res, next, kind) {
  try {
    const take = await ownTake(req.params.id, req.user.id);
    if (!take || !(await fileExists(take.file_path))) return res.status(404).json({ error: 'Take not available' });
    const out = `${take.file_path}.${kind}.jpg`;
    if (!(await fileExists(out))) {
      const duration = take.duration_seconds ?? 1;
      if (kind === 'poster') await extractPoster(take.file_path, out, Math.min(0.8, duration / 3));
      else await extractStrip(take.file_path, out, duration);
    }
    res.sendFile(out, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } });
  } catch (err) {
    next(err);
  }
}
app.get('/api/takes/:id/poster', requireUser, (req, res, next) => takeImage(req, res, next, 'poster'));
app.get('/api/takes/:id/strip', requireUser, (req, res, next) => takeImage(req, res, next, 'strip'));

// A kept take's video, for showing it again after the app reloads.
app.get('/api/takes/:id/file', requireUser, async (req, res, next) => {
  try {
    const take = await ownTake(req.params.id, req.user.id);
    if (!take || !(await fileExists(take.file_path))) return res.status(404).json({ error: 'Take not available' });
    res.sendFile(take.file_path, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    next(err);
  }
});

// Re-upload a kept take whose file is gone (Render's disk is wiped on restart).
app.put('/api/takes/:id/file', requireUser, videoUpload.single('video'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Send the video in the "video" field' });
  let stored = false;
  try {
    const take = await ownTake(req.params.id, req.user.id);
    if (!take) return res.status(404).json({ error: 'Take not found' });
    const filePath = path.join(takesDir, `${take.id}${path.extname(req.file.path) || '.webm'}`);
    await fs.promises.rename(req.file.path, filePath);
    stored = true;
    await pool.query('UPDATE takes SET file_path = $2 WHERE id = $1', [take.id, filePath]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  } finally {
    if (!stored) fs.promises.rm(req.file.path, { force: true });
  }
});

app.post('/api/reels', requireUser, limits.reels, async (req, res, next) => {
  if (!pool) return res.status(503).json({ error: 'Reels need a database' });
  const takeIds = Array.isArray(req.body?.takeIds) ? req.body.takeIds.map(Number).filter(Number.isInteger) : [];
  if (takeIds.length === 0 || takeIds.length > 6) return res.status(400).json({ error: 'Send 1 to 6 take ids in shot order' });
  try {
    const { rows } = await pool.query('SELECT * FROM takes WHERE user_id = $1 AND id = ANY($2)', [req.user.id, takeIds]);
    const byId = new Map(rows.map((t) => [Number(t.id), t]));
    const takes = takeIds.map((id) => byId.get(id));
    if (takes.some((t) => !t)) return res.status(404).json({ error: 'Some takes were not found' });
    // Free plan: a few reels a month; Pro: unlimited.
    const plan = await planFor(req.user.id);
    if (plan.reelsThisMonth >= plan.reelsPerMonth) {
      return res.status(402).json({ error: `Free includes ${plan.reelsPerMonth} reels a month. Go Pro for unlimited reels.`, upgrade: true });
    }
    const missing = [];
    for (const t of takes) if (!(await fileExists(t.file_path))) missing.push(Number(t.id));
    // The phone still has these; it re-uploads them and asks again.
    if (missing.length) return res.status(409).json({ error: 'Some takes need re-uploading', missing });

    const { rows: [reel] } = await pool.query(
      'INSERT INTO reels (user_id, plan_id, take_ids, captions) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, takes[0].plan_id, takeIds, req.body.captions !== false],
    );
    enqueueReel({ ...reel, takes, maxLongEdge: plan.maxLongEdge, tag: plan.tag });
    res.status(202).json({ reelId: reel.id });
  } catch (err) {
    next(err);
  }
});

async function ownReel(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT * FROM reels WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] ?? null;
}

app.get('/api/reels/:id', requireUser, async (req, res, next) => {
  try {
    const reel = await ownReel(req.params.id, req.user.id);
    if (!reel) return res.status(404).json({ error: 'Reel not found' });
    const job = jobStatus(reel.id);
    res.json({
      status: job?.status === 'working' ? 'working' : reel.status === 'queued' && !job ? 'error' : reel.status,
      progress: reel.status === 'done' ? 1 : (job?.progress ?? 0),
      stage: job?.stage ?? null,
      error: reel.error ?? (reel.status === 'queued' && !job ? 'The server restarted. Try again.' : null),
      width: reel.width,
      height: reel.height,
      durationSeconds: reel.duration_seconds,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/reels/:id/file', requireUser, async (req, res, next) => {
  try {
    const reel = await ownReel(req.params.id, req.user.id);
    if (!reel || reel.status !== 'done' || !(await fileExists(reel.file_path))) {
      return res.status(404).json({ error: 'Reel not available' });
    }
    if (req.query.download) res.attachment(`darpan-reel-${reel.id}.mp4`);
    res.sendFile(reel.file_path, { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    next(err);
  }
});

function safeJson(text) {
  try {
    return typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Hashed build files never change; everything else is checked on each visit.
function cacheControl(rel) {
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  if (rel.startsWith('mediapipe/') || rel.startsWith('icons/')) return 'public, max-age=604800';
  return 'no-cache';
}

// Serve the Brotli/gzip copies made at build time (scripts/precompress.mjs)
// instead of compressing on every request. Safari and Chrome both accept br.
const precompressed = new Set();
(function index(dir) {
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) index(full);
    else if (full.endsWith('.br') || full.endsWith('.gz')) precompressed.add(full);
  }
})(config.staticDir);

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const accept = req.get('accept-encoding') ?? '';
  const encodings = [/\bbr\b/.test(accept) && ['br', 'br'], /\bgzip\b/.test(accept) && ['gz', 'gzip']].filter(Boolean);
  if (!encodings.length) return next();
  const file = path.join(config.staticDir, path.normalize(decodeURIComponent(req.path)));
  if (!file.startsWith(config.staticDir)) return next();
  const match = encodings.find(([ext]) => precompressed.has(`${file}.${ext}`));
  if (!match) return next();
  const rel = path.relative(config.staticDir, file).replace(/\\/g, '/');
  res.type(path.extname(file)); // the original type (application/wasm for streaming compile)
  res.set({ 'Content-Encoding': match[1], Vary: 'Accept-Encoding', 'Cache-Control': cacheControl(rel) });
  res.sendFile(`${file}.${match[0]}`);
});

app.use(
  express.static(config.staticDir, {
    index: false,
    setHeaders(res, filePath) {
      res.set('Cache-Control', cacheControl(path.relative(config.staticDir, filePath).replace(/\\/g, '/')));
      res.vary('Accept-Encoding');
    },
  }),
);
app.get('/{*splat}', (_req, res) =>
  res.sendFile(path.join(config.staticDir, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }),
);

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message });
  }
  if ([TranscribeError, ClaudeError, TtsError, BillingError].some((type) => err instanceof type)) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

await migrate();
await reconcilePro().catch((err) => console.error('Pro reconcile failed:', err.message));
sweepOldFiles().catch(() => {});
startPaymentSweeper();
setInterval(() => sweepOldFiles().catch(() => {}), 60 * 60 * 1000).unref();
const server = app.listen(config.port, () => console.log(`Darpan listening on :${config.port}`));

// Render sends SIGTERM before replacing the instance on a deploy.
process.on('SIGTERM', () => {
  console.log('SIGTERM: finishing open requests');
  server.close(() => pool?.end().finally(() => process.exit(0)) ?? process.exit(0));
  setTimeout(() => process.exit(0), 25_000).unref();
});
