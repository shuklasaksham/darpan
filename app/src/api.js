async function request(url, options) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

export const getHealth = () => request('/api/health');

export const planShoot = (brief) =>
  request('/api/director/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(brief),
  });

export const nextShot = (body) =>
  request('/api/director/next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export function uploadTake(file, { planId, plan, shotIndex } = {}) {
  const body = new FormData();
  if (planId) body.append('planId', planId);
  else if (plan) body.append('plan', JSON.stringify(plan));
  if (shotIndex !== undefined) body.append('shotIndex', shotIndex);
  body.append('video', file);
  return request('/api/takes', { method: 'POST', body });
}
