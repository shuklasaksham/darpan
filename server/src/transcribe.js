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
  return (await transcribeWithWords(filePath, mimeType, language)).transcript;
}

/**
 * Like transcribeFile, but also returns word timings. With `keepFillers`,
 * "um" and "uh" stay in (Deepgram drops them by default; its docs only promise
 * this for English, but Hindi fillers like "matlab" are ordinary words anyway).
 */
export async function transcribeWithWords(filePath, mimeType, language = 'Hinglish', { keepFillers = false } = {}) {
  if (!config.deepgramApiKey) throw new TranscribeError('Voice input is not set up yet', 503);

  const params = new URLSearchParams({ model: 'nova-3', language: 'multi', smart_format: 'true' });
  if (keepFillers) params.set('filler_words', 'true');
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
  const alt = json.results?.channels?.[0]?.alternatives?.[0];
  return {
    transcript: alt?.transcript?.trim() ?? '',
    words: (alt?.words ?? []).map((w) => ({
      word: w.word,
      text: w.punctuated_word ?? w.word,
      start: w.start,
      end: w.end,
    })),
  };
}
