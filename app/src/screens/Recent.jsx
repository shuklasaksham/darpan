import { useEffect, useState } from 'react';
import { getRecent } from '../api.js';

const ACTIVE_KEY = 'darpan.activePlan';

/** Remembers which shoot is open, so a reload can drop the creator back into it. */
export function rememberActive(planId) {
  try {
    if (planId) localStorage.setItem(ACTIVE_KEY, String(planId));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

export function activePlanId() {
  try {
    return Number(localStorage.getItem(ACTIVE_KEY)) || null;
  } catch {
    return null;
  }
}

/** Turns a recent shoot into what the camera needs to resume it. */
export function resumeState(item) {
  const kept = {};
  for (const k of item.kept ?? []) {
    if (k.shotIndex == null || !k.available) continue;
    kept[k.shotIndex] = { takeId: Number(k.id), blob: null, url: `/api/takes/${k.id}/file`, result: { id: k.id, score: k.score } };
  }
  return {
    shoot: { idea: item.brief?.idea ?? null, format: item.brief?.format ?? null, language: item.script?.language ?? item.brief?.language ?? 'Hinglish' },
    planned: { planId: item.planId, script: item.script },
    kept,
  };
}

export function RecentShoots({ onResume }) {
  const [shoots, setShoots] = useState(null);

  useEffect(() => {
    getRecent()
      .then(({ shoots }) => setShoots(shoots))
      .catch(() => setShoots([]));
  }, []);

  if (!shoots?.length) return null;
  return (
    <section className="stack">
      <h3>Recent</h3>
      <ul className="recent">
        {shoots.map((s) => {
          const total = s.script?.shots?.length ?? 0;
          const done = new Set((s.kept ?? []).filter((k) => k.available).map((k) => k.shotIndex)).size;
          const status = s.reel?.status === 'done' ? 'Reel made' : done >= total && total ? 'Ready for reel' : `${done} of ${total} shots`;
          return (
            <li key={s.planId}>
              <button className="recent-item" onClick={() => onResume(resumeState(s))}>
                <span>
                  <strong>{s.script?.title || s.brief?.idea || 'Untitled reel'}</strong>
                  <small className="muted">
                    {new Date(s.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · {status}
                  </small>
                </span>
                <span className="progress-dots" aria-hidden="true">
                  {Array.from({ length: total }, (_, i) => (
                    <i key={i} className={(s.kept ?? []).some((k) => k.shotIndex === i && k.available) ? 'on' : ''} />
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
