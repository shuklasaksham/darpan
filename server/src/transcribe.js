import fs from 'node:fs';
import { config } from './config.js';

// Nova-3 in multilingual mode handles Hindi and English switching mid-sentence
// (Hinglish), which the browser's own speech recognition garbles.
const LANGUAGE_HINTS = {
  Hinglish: ['hi', 'en'],
  Hindi: ['hi', 'en'],
  English: ['en', 'hi'],
};

export class TranscribeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Streams an audio file from disk to Deepgram and returns the transcript. */
export async function transcribeFile(filePath, mimeType, language = 'Hinglish') {
  if (!config.deepgramApiKey) throw new TranscribeError('Voice input is not set up yet', 503);

  const params = new URLSearchParams({ model: 'nova-3', language: 'multi', smart_format: 'true' });
  for (const hint of LANGUAGE_HINTS[language] ?? LANGUAGE_HINTS.Hinglish) params.append('language_hint', hint);

  let res;
  try {
    res = await fetch(`${config.deepgramBaseUrl}/v1/listen?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${config.deepgramApiKey}`,
        'Content-Type': mimeType?.split(';')[0] || 'application/octet-stream',
      },
      body: fs.createReadStream(filePath),
      duplex: 'half',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error('Deepgram request failed:', err.message);
    throw new TranscribeError("Couldn't reach the voice service. Try again or type your idea.");
  }
  if (!res.ok) {
    console.error('Deepgram error', res.status, await res.text().catch(() => ''));
    throw new TranscribeError("Couldn't understand that recording. Try again or type your idea.");
  }
  const json = await res.json();
  return json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
}
