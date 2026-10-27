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

// Sarvam's Saaras is trained on Indian speech and code-mixing, so it hears a
// spoken idea far better than a general model. How each script language is written:
const SARVAM_MODES = {
  Hinglish: { mode: 'translit', language_code: 'unknown' }, // Roman letters, the way the script is written
  Hindi: { mode: 'codemix', language_code: 'hi-IN' }, // Devanagari, English words left in English
  English: { mode: 'transcribe', language_code: 'unknown' },
};

/**
 * The creator's spoken idea as text: Sarvam when it's set up (best for Indian
 * speech), Deepgram otherwise or if Sarvam fails.
 */
export async function transcribeFile(filePath, mimeType, language = 'Hinglish') {
  if (config.sarvamApiKey) {
    try {
      const transcript = await transcribeSarvam(filePath, mimeType, language);
      if (transcript || !config.deepgramApiKey) return transcript;
    } catch (err) {
      console.error('Sarvam transcription failed, trying Deepgram:', err.message);
      if (!config.deepgramApiKey) throw new TranscribeError("Couldn't understand that recording. Try again or type your idea.");
    }
  }
  return (await transcribeWithWords(filePath, mimeType, language)).transcript;
}

async function transcribeSarvam(filePath, mimeType, language) {
  const { mode, language_code } = SARVAM_MODES[language] ?? SARVAM_MODES.Hinglish;
  const type = mimeType?.split(';')[0] || 'audio/webm';
  const body = new FormData();
  body.append('file', new Blob([await fs.promises.readFile(filePath)], { type }), `idea.${type.split('/')[1] || 'webm'}`);
  body.append('model', 'saaras:v3');
  body.append('mode', mode);
  body.append('language_code', language_code);
  const res = await fetch(`${config.sarvamBaseUrl}/speech-to-text`, {
    method: 'POST',
    headers: { 'api-subscription-key': config.sarvamApiKey },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Sarvam ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const json = await res.json();
  return json.transcript?.trim() ?? '';
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
