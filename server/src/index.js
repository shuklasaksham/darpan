import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { pool, migrate } from './db.js';
import { probe, ffmpegAvailable } from './ffmpeg.js';
import { directorConfigured, DirectorError, planShoot, recommendShot, reviewTake } from './director.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

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
    director: directorConfigured,
    keys: {
      anthropic: Boolean(config.anthropicApiKey),
      deepgram: Boolean(config.deepgramApiKey),
      sarvam: Boolean(config.sarvamApiKey),
      agenticorg: Boolean(config.agenticorgApiKey),
    },
  });
});

async function loadPlan(planId) {
  if (!pool || !planId) return null;
  const { rows } = await pool.query('SELECT plan FROM shoot_plans WHERE id = $1', [planId]);
  return rows[0]?.plan ?? null;
}

app.post('/api/director/plan', async (req, res, next) => {
  const { idea, language, durationSeconds, niche } = req.body ?? {};
  if (typeof idea !== 'string' || !idea.trim() || idea.length > 500) {
    return res.status(400).json({ error: 'Describe your reel idea in up to 500 characters' });
  }
  try {
    const brief = { idea: idea.trim(), language, durationSeconds: Number(durationSeconds) || undefined, niche };
    const plan = await planShoot(brief);
    let planId = null;
    if (pool) {
      const { rows } = await pool.query(
        'INSERT INTO shoot_plans (brief, plan, agent_run_id) VALUES ($1, $2, $3) RETURNING id',
        [brief, plan, plan.runId],
      );
      planId = rows[0].id;
    }
    res.json({ planId, plan });
  } catch (err) {
    next(err);
  }
});

app.post('/api/director/next', async (req, res, next) => {
  const { planId, plan: clientPlan, shotsDone = [], situation } = req.body ?? {};
  try {
    const plan = (await loadPlan(planId)) ?? clientPlan;
    if (!plan) return res.status(400).json({ error: 'Plan a shoot first' });
    res.json(await recommendShot({ plan, shotsDone, situation }));
  } catch (err) {
    next(err);
  }
});

app.post('/api/takes', upload.single('video'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Send a video in the "video" field' });
  try {
    const meta = await probe(req.file.path).catch(() => null);
    if (!meta) return res.status(422).json({ error: "Couldn't read that file as a video" });

    const planId = Number(req.body.planId) || null;
    const shotIndex = req.body.shotIndex === undefined ? null : Number(req.body.shotIndex);

    // Feedback from the director is a bonus; the take still counts if it fails.
    let review = null;
    if (directorConfigured && shotIndex !== null) {
      const plan = (await loadPlan(planId)) ?? safeJson(req.body.plan);
      const shot = plan?.shots?.[shotIndex];
      if (shot) review = await reviewTake({ shot, take: meta }).catch(() => null);
    }

    let id = null;
    if (pool) {
      const { rows } = await pool.query(
        `INSERT INTO takes (original_name, size_bytes, duration_seconds, width, height, plan_id, shot_index, review)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [req.file.originalname, req.file.size, meta.durationSeconds, meta.width, meta.height, planId, shotIndex, review],
      );
      id = rows[0].id;
    }
    res.json({ id, ...meta, review });
  } catch (err) {
    next(err);
  } finally {
    // Render's disk is ephemeral; nothing is kept past the request for now.
    fs.promises.rm(req.file.path, { force: true });
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

app.use(express.static(config.staticDir, { index: false, maxAge: '1h' }));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(config.staticDir, 'index.html')));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message });
  }
  if (err instanceof DirectorError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

await migrate();
app.listen(config.port, () => console.log(`Darpan listening on :${config.port}`));
