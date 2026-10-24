import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { pool, migrate } from './db.js';
import { extractAudio, probe, ffmpegAvailable } from './ffmpeg.js';
import { analyzeTake, ruleNotes } from './analyze.js';
import { authRouter, loadUser, requireUser } from './auth.js';
import { transcribeFile, transcribeWithWords, TranscribeError } from './transcribe.js';
import { directorConfigured, DirectorError, suggestIdeas } from './director.js';
import { checkFrame, ClaudeError, claudeConfigured, directorNotes, writeScript } from './claude.js';
import { speak, TtsError, ttsConfigured } from './tts.js';

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
    director: directorConfigured,
    scripts: claudeConfigured,
    voice: Boolean(config.deepgramApiKey),
    tts: ttsConfigured,
    keys: {
      anthropic: Boolean(config.anthropicApiKey),
      deepgram: Boolean(config.deepgramApiKey),
      sarvam: Boolean(config.sarvamApiKey),
      agenticorg: Boolean(config.agenticorgApiKey),
    },
  });
});

app.use('/api/auth', authRouter);

app.post('/api/transcribe', requireUser, audioUpload.single('audio'), async (req, res, next) => {
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

app.get('/api/director/ideas', requireUser, async (req, res, next) => {
  try {
    const { ideas } = await suggestIdeas({ creator: req.user, language: req.query.language });
    res.json({ ideas: Array.isArray(ideas) ? ideas : [] });
  } catch (err) {
    next(err);
  }
});

app.post('/api/script', requireUser, async (req, res, next) => {
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

app.post('/api/frame-check', requireUser, async (req, res, next) => {
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

app.post('/api/tts', requireUser, async (req, res, next) => {
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
app.post('/api/takes', requireUser, videoUpload.single('video'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Send a video in the "video" field' });
  const audioPath = `${req.file.path}.wav`;
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
                            transcript, score, notes, features, notes_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
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
        ],
      );
      id = rows[0].id;
    }
    res.json({
      id,
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
    // Render's disk is ephemeral; nothing is kept past the request for now.
    fs.promises.rm(req.file.path, { force: true });
    fs.promises.rm(audioPath, { force: true });
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
  if ([DirectorError, TranscribeError, ClaudeError, TtsError].some((type) => err instanceof type)) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

await migrate();
app.listen(config.port, () => console.log(`Darpan listening on :${config.port}`));
