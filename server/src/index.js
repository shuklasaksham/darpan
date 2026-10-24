import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { pool, migrate } from './db.js';
import { probe, ffmpegAvailable } from './ffmpeg.js';

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
    keys: {
      anthropic: Boolean(config.anthropicApiKey),
      deepgram: Boolean(config.deepgramApiKey),
      sarvam: Boolean(config.sarvamApiKey),
    },
  });
});

app.post('/api/takes', upload.single('video'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Send a video in the "video" field' });
  try {
    const meta = await probe(req.file.path).catch(() => null);
    if (!meta) return res.status(422).json({ error: "Couldn't read that file as a video" });
    let id = null;
    if (pool) {
      const { rows } = await pool.query(
        `INSERT INTO takes (original_name, size_bytes, duration_seconds, width, height)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [req.file.originalname, req.file.size, meta.durationSeconds, meta.width, meta.height],
      );
      id = rows[0].id;
    }
    res.json({ id, ...meta });
  } catch (err) {
    next(err);
  } finally {
    // Render's disk is ephemeral; nothing is kept past the request for now.
    fs.promises.rm(req.file.path, { force: true });
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(config.staticDir, { index: false, maxAge: '1h' }));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(config.staticDir, 'index.html')));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

await migrate();
app.listen(config.port, () => console.log(`Darpan listening on :${config.port}`));
