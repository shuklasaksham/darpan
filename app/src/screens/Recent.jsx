import { posterUrl } from '../api.js';
import Glyph from '../ui/Glyph.jsx';
import { Poster, formatTime } from '../ui/parts.jsx';

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

/** How far a shoot got: kept shots, the next shot to shoot, and a take to use as its thumbnail. */
export function shootProgress(s) {
  const total = s.script?.shots?.length ?? 0;
  const available = (s.kept ?? []).filter((k) => k.available && k.shotIndex != null);
  const done = new Set(available.map((k) => k.shotIndex));
  const nextIndex = Array.from({ length: total }, (_, i) => i).find((i) => !done.has(i)) ?? 0;
  return {
    total,
    kept: done.size,
    ready: total > 0 && done.size >= total,
    nextIndex,
    posterTakeId: available.sort((a, b) => a.shotIndex - b.shotIndex)[0]?.id ?? null,
  };
}

/** The finished reel's file is still on the server (older servers don't say: assume it is). */
const reelReady = (s) => s.reel?.status === 'done' && s.reel.available !== false;

function status(s) {
  const p = shootProgress(s);
  if (reelReady(s)) return { text: `Ready${s.reel.durationSeconds ? ` · ${formatTime(s.reel.durationSeconds)}` : ''}`, good: true };
  // The reel was made but its video has been cleared; the script is kept, so it can be shot again.
  if (s.reel?.status === 'done') return { text: p.ready ? 'Reel cleared · make it again' : 'Video cleared · shoot again', good: false };
  if (p.ready) return { text: 'All shots kept', good: true };
  if (p.kept === 0) return { text: 'Script only', good: false };
  return { text: `${p.kept} of ${p.total} shots`, good: false };
}

export function RecentReels({ shoots, onResume, onStart }) {
  return (
    <main className="screen with-tabs">
      <div className="stack tight" style={{ paddingTop: 'var(--space-6)' }}>
        <h1 className="display" style={{ fontSize: 40 }}>Your reels</h1>
        {shoots?.length > 0 && (
          <p className="muted">
            {shoots.length} {shoots.length === 1 ? 'shoot' : 'shoots'} · download within 24 hours
          </p>
        )}
      </div>
      {shoots === null && <div className="loader" aria-label="Loading" />}
      {shoots?.length === 0 && (
        <div className="big-state">
          <h2>No reels yet</h2>
          <p className="muted">Your shoots show up here, with every take you keep. Start with an idea on Home.</p>
          <button className="primary" onClick={onStart}>Make my first reel</button>
        </div>
      )}
      {shoots?.length > 0 && (
        <ul className="recent-grid">
          {shoots.map((s) => {
            const p = shootProgress(s);
            const st = status(s);
            return (
              <li key={s.planId}>
                <button onClick={() => onResume(resumeState(s))}>
                  <Poster src={p.posterTakeId ? posterUrl(p.posterTakeId) : null}>
                    {reelReady(s) && (
                      <span className="badge" aria-hidden="true">
                        <Glyph name="reel" size={18} />
                      </span>
                    )}
                  </Poster>
                  <span>
                    <strong>{s.script?.title || s.brief?.idea || 'Untitled reel'}</strong>
                    <br />
                    <small className={st.good ? 'good-text' : ''}>{st.text}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
