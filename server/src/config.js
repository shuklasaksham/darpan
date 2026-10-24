import os from 'node:os';
import path from 'node:path';

export const config = {
  port: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  sarvamApiKey: process.env.SARVAM_API_KEY,
  // Uploads are streamed to disk, never buffered in memory (the server has 512 MB).
  uploadDir: process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'darpan-uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024,
  staticDir: process.env.STATIC_DIR || path.resolve(import.meta.dirname, '../../app/dist'),
};
