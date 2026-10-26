export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(url, options) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error || res.statusText, res.status, json);
  return json;
}

const postJson = (url, body) =>
  request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const getHealth = () => request('/api/health');

export const getMe = () => request('/api/auth/me');
export const suggestUsernames = (name) => postJson('/api/auth/username-suggestions', { name });
export const signUp = (details) => postJson('/api/auth/signup', details);
export const logIn = (username, pin) => postJson('/api/auth/login', { username, pin });
export const logOut = () => postJson('/api/auth/logout', {});

export const getTrends = (language) => request(`/api/trends?language=${encodeURIComponent(language)}`);
export const writeScript = (brief) => postJson('/api/script', brief);
export const saveScript = (planId, script) =>
  request(`/api/plans/${planId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script }) });
export const getBilling = () => request('/api/billing');
export const startCheckout = () => postJson('/api/billing/checkout', {});
export const verifyRazorpay = (body) => postJson('/api/billing/razorpay/verify', body);
export const getRecent = () => request('/api/recent');
export const checkFrame = (body) => postJson('/api/frame-check', body);
export const keepTake = (id) => postJson(`/api/takes/${id}/keep`, {});
export const getPlanTakes = (planId) => request(`/api/plans/${planId}/takes`);
export const editTake = (id, patch) =>
  request(`/api/takes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
export const posterUrl = (takeId) => `/api/takes/${takeId}/poster`;
export const stripUrl = (takeId) => `/api/takes/${takeId}/strip`;
export const makeReel = (body) => postJson('/api/reels', body);
export const getReel = (id) => request(`/api/reels/${id}`);

export function reuploadTake(id, blob) {
  const body = new FormData();
  body.append('video', blob, blob.name ?? `take.${extensionFor(blob.type)}`);
  return request(`/api/takes/${id}/file`, { method: 'PUT', body });
}

export function transcribe(blob, language) {
  const body = new FormData();
  body.append('language', language);
  body.append('audio', blob, `idea.${extensionFor(blob.type)}`);
  return request('/api/transcribe', { method: 'POST', body });
}

/** XHR rather than fetch, for upload progress; a network failure rejects with `offline: true`. */
function send(method, url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      const json = xhr.response ?? {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(json);
      else reject(new ApiError(json.error || xhr.statusText || 'Upload failed', xhr.status, json));
    };
    xhr.onerror = () => reject(Object.assign(new ApiError("You're offline", 0, {}), { offline: true }));
    xhr.send(body);
  });
}

/**
 * Sends a take for notes: its audio alone when there is one (small, so scoring
 * starts in seconds; the video follows with uploadTakeFile), else the video.
 */
export function uploadTake(blob, { audio, aspect, planId, plan, shotIndex, durationSeconds, language, loudness, gaze, frames } = {}, onProgress) {
  const body = new FormData();
  if (language) body.append('language', language);
  if (aspect) body.append('aspect', aspect);
  if (loudness?.length) body.append('loudness', JSON.stringify(loudness));
  if (gaze?.length) body.append('gaze', JSON.stringify(gaze));
  if (frames?.length) body.append('frames', JSON.stringify(frames));
  if (planId) body.append('planId', planId);
  else if (plan) body.append('plan', JSON.stringify(plan));
  if (shotIndex !== undefined) body.append('shotIndex', shotIndex);
  if (durationSeconds) body.append('durationSeconds', durationSeconds);
  if (audio) body.append('audio', audio, `take.${extensionFor(audio.type)}`);
  if (blob) body.append('video', blob, blob.name ?? `take.${extensionFor(blob.type)}`);
  return send('POST', '/api/takes', body, onProgress);
}

// Videos still uploading in the background, by take id.
const uploads = new Map(); // takeId -> { promise, progress }

/**
 * Uploads a scored take's video in the background, retrying when the
 * connection drops. Making the reel waits for these (waitForUploads).
 */
export function uploadTakeFile(id, blob) {
  const key = Number(id);
  const entry = { progress: 0, promise: null };
  entry.promise = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const body = new FormData();
        body.append('video', blob, blob.name ?? `take.${extensionFor(blob.type)}`);
        await send('PUT', `/api/takes/${key}/file`, body, (p) => (entry.progress = p));
        entry.progress = 1;
        return;
      } catch (err) {
        if (!err.offline || attempt >= 5) throw err;
        // Back online, or a few seconds later, whichever comes first.
        await new Promise((resolve) => {
          const done = () => {
            window.removeEventListener('online', done);
            resolve();
          };
          window.addEventListener('online', done);
          setTimeout(done, 3000 * (attempt + 1));
        });
      }
    }
  })().finally(() => uploads.delete(key));
  uploads.set(key, entry);
  return entry.promise;
}

/** Waits for the background uploads of these takes (all, when no ids), reporting overall progress 0-1. */
export async function waitForUploads(ids = null, onProgress) {
  const keys = (ids ?? [...uploads.keys()]).map(Number).filter((k) => uploads.has(k));
  if (!keys.length) return;
  const timer = setInterval(() => onProgress?.(keys.reduce((n, k) => n + (uploads.get(k)?.progress ?? 1), 0) / keys.length), 300);
  try {
    await Promise.allSettled(keys.map((k) => uploads.get(k)?.promise));
  } finally {
    clearInterval(timer);
  }
}

export const uploadsPending = () => uploads.size > 0;

function extensionFor(mimeType = '') {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}
