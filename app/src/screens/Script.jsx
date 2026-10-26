import { useEffect, useState } from 'react';
import { saveScript, writeScript } from '../api.js';
import { FRAMINGS } from '../camera/framing.js';

// Start downloading and starting the camera's face detection (and the camera
// screen's code) while the creator reads their script, so the camera opens ready.
function warmUpCamera() {
  const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 600)); // Safari has no requestIdleCallback
  idle(() => {
    import('./Camera.jsx').catch(() => {});
    import('../camera/vision.js').then((v) => v.loadFaceDetector()).catch(() => {});
  });
}

export function fallbackScript({ idea, format, language }) {
  return {
    title: idea || format || 'Your reel',
    hook: '',
    trend_used: '',
    language,
    shots: [
      {
        title: 'Your take',
        framing: format === 'Day in my life' ? 'full_body' : 'medium',
        pose: 'neutral',
        line: idea || 'Say your idea in your own words.',
        direction: 'Look into the lens and talk like you would to a friend.',
        duration_seconds: 30,
      },
    ],
    background: null,
    lighting: null,
  };
}

/**
 * Claude writes the script here, the creator edits it, and only then does the
 * camera open.
 */
export default function Script({ shoot, health, onStart, onBack }) {
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [planId, setPlanId] = useState(null);
  const [script, setScript] = useState(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(warmUpCamera, []);

  useEffect(() => {
    let alive = true;
    setState('loading');
    if (!health?.scripts) {
      setScript(fallbackScript(shoot));
      setState('ready');
      return;
    }
    writeScript({ idea: shoot.idea, format: shoot.format, language: shoot.language })
      .then((r) => {
        if (!alive) return;
        setPlanId(r.planId);
        setScript(r.script);
        setState('ready');
      })
      .catch((err) => {
        if (!alive) return;
        setError(err.message);
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [shoot, health?.scripts, attempt]);

  const updateShot = (i, patch) =>
    setScript((s) => ({ ...s, shots: s.shots.map((shot, j) => (j === i ? { ...shot, ...patch } : shot)) }));

  async function start() {
    const shots = script.shots.filter((s) => s.line.trim());
    if (!shots.length) return setError('Add at least one line to say.');
    const edited = { ...script, shots };
    setSaving(true);
    setError('');
    try {
      const saved = planId ? await saveScript(planId, edited) : { planId: null, script: edited };
      onStart(saved);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  if (state === 'loading') {
    return (
      <main className="center">
        <div className="loader" aria-hidden="true" />
        <h2>Writing your script…</h2>
        <p className="muted">Checking what's trending in your niche and planning only the shots you need.</p>
      </main>
    );
  }

  if (state === 'error') {
    return (
      <main className="center">
        <p className="error">{error}</p>
        <div className="stack">
          <button className="primary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          <button
            onClick={() => {
              setScript(fallbackScript(shoot));
              setState('ready');
            }}
          >
            Write it myself
          </button>
          <button className="link" onClick={onBack}>Back</button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <header className="top">
        <button className="link" onClick={onBack}>← Back</button>
        {health?.scripts && (
          <button className="link" onClick={() => setAttempt((n) => n + 1)}>Rewrite</button>
        )}
      </header>
      <input
        className="title-input"
        value={script.title}
        onChange={(e) => setScript((s) => ({ ...s, title: e.target.value }))}
        aria-label="Reel title"
      />
      {script.trend_used && <p className="tag-line">Trend: {script.trend_used}</p>}
      <p className="muted">Edit anything you like. Your lines show on the teleprompter.</p>

      <details className="card full-script" open>
        <summary>
          <h3>Full script</h3>
        </summary>
        {script.shots.map((shot, i) => (
          <p key={i}>
            <span className="muted">{shot.title}: </span>
            {shot.line || <em className="muted">(no line yet)</em>}
          </p>
        ))}
        {script.caption && (
          <p className="muted">
            Caption: {script.caption} {Array.isArray(script.hashtags) ? script.hashtags.join(' ') : ''}
          </p>
        )}
      </details>

      <ol className="edit-shots">
        {script.shots.map((shot, i) => (
          <li key={i} className="card">
            <div className="row between">
              <input
                className="shot-title"
                value={shot.title}
                onChange={(e) => updateShot(i, { title: e.target.value })}
                aria-label={`Shot ${i + 1} title`}
              />
              {script.shots.length > 1 && (
                <button
                  className="link"
                  onClick={() => setScript((s) => ({ ...s, shots: s.shots.filter((_, j) => j !== i) }))}
                >
                  Remove
                </button>
              )}
            </div>
            <label>
              What you say
              <textarea value={shot.line} rows={3} onChange={(e) => updateShot(i, { line: e.target.value })} />
            </label>
            <div className="row">
              <select value={shot.framing} onChange={(e) => updateShot(i, { framing: e.target.value })} aria-label="Framing">
                {Object.entries(FRAMINGS).map(([key, f]) => (
                  <option key={key} value={key}>{f.label}</option>
                ))}
              </select>
              <select
                value={shot.duration_seconds}
                onChange={(e) => updateShot(i, { duration_seconds: Number(e.target.value) })}
                aria-label="Length"
              >
                {[3, 5, 8, 10, 15, 20, 30, 45, 60].map((n) => <option key={n} value={n}>{n}s</option>)}
              </select>
            </div>
            {shot.direction && <p className="muted">{shot.direction}</p>}
          </li>
        ))}
      </ol>
      {script.shots.length < 6 && (
        <button
          onClick={() =>
            setScript((s) => ({
              ...s,
              shots: [...s.shots, { title: `Shot ${s.shots.length + 1}`, line: '', framing: 'medium', pose: 'neutral', direction: '', duration_seconds: 5 }],
            }))
          }
        >
          + Add a shot
        </button>
      )}

      {script.background && (
        <section className="card">
          <h3>Background</h3>
          <p>{script.background.suggestion}</p>
          {script.background.avoid?.length > 0 && <p className="muted">Avoid: {script.background.avoid.join(', ')}</p>}
        </section>
      )}
      {script.lighting && (
        <section className="card">
          <h3>Lighting</h3>
          <p>{script.lighting.suggestion}</p>
          {script.lighting.avoid?.length > 0 && <p className="muted">Avoid: {script.lighting.avoid.join(', ')}</p>}
        </section>
      )}

      {error && <p className="error">{error}</p>}
      <button className="primary sticky-cta" onClick={start} disabled={saving}>
        {saving ? 'Saving…' : 'Looks good, open camera'}
      </button>
    </main>
  );
}
