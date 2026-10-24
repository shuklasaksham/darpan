import { config } from './config.js';

export const ttsConfigured = Boolean(config.sarvamApiKey);

const LANGUAGES = new Set(['hi-IN', 'en-IN']);
const MAX_CACHED = 150;
// Tips repeat a lot ("lower the phone"), so keep recent clips in memory (~30 KB each).
const cache = new Map();

export class TtsError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Speaks a short tip with Sarvam Bulbul in an Indian voice. Returns MP3 bytes. */
export async function speak(text, languageCode) {
  if (!ttsConfigured) throw new TtsError('Voice tips are not set up', 503);
  const language = LANGUAGES.has(languageCode) ? languageCode : 'hi-IN';
  const key = `${language}|${text}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  let res;
  try {
    res = await fetch(`${config.sarvamBaseUrl}/text-to-speech`, {
      method: 'POST',
      headers: { 'api-subscription-key': config.sarvamApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        language_code: language,
        model: 'bulbul:v3',
        speaker: config.sarvamSpeaker,
        // A touch slower and more expressive, so tips sound warm rather than curt.
        pace: 0.92,
        temperature: 0.75,
        output_audio_codec: 'mp3',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error('Sarvam request failed:', err.message);
    throw new TtsError('Voice service unreachable');
  }
  if (!res.ok) {
    console.error('Sarvam error', res.status, await res.text().catch(() => ''));
    throw new TtsError('Voice service error');
  }
  const json = await res.json();
  const audio = json.audios?.[0] ? Buffer.from(json.audios[0], 'base64') : null;
  if (!audio) throw new TtsError('Voice service returned no audio');

  cache.set(key, audio);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return audio;
}
