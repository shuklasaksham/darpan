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

export const getIdeas = (language) => request(`/api/director/ideas?language=${encodeURIComponent(language)}`);
export const planShoot = (brief) => postJson('/api/director/plan', brief);
export const nextShot = (body) => postJson('/api/director/next', body);

export function transcribe(blob, language) {
  const body = new FormData();
  body.append('language', language);
  body.append('audio', blob, `idea.${extensionFor(blob.type)}`);
  return request('/api/transcribe', { method: 'POST', body });
}

export function uploadTake(blob, { planId, plan, shotIndex, durationSeconds } = {}) {
  const body = new FormData();
  if (planId) body.append('planId', planId);
  else if (plan) body.append('plan', JSON.stringify(plan));
  if (shotIndex !== undefined) body.append('shotIndex', shotIndex);
  if (durationSeconds) body.append('durationSeconds', durationSeconds);
  body.append('video', blob, blob.name ?? `take.${extensionFor(blob.type)}`);
  return request('/api/takes', { method: 'POST', body });
}

function extensionFor(mimeType = '') {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}
