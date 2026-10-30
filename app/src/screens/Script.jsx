import { useEffect, useState } from 'react';
import { saveScript, writeScript } from '../api.js';
import { FRAMINGS, framingFor } from '../camera/framing.js';
import Glyph from '../ui/Glyph.jsx';
import { BackBar, FramingTile } from '../ui/parts.jsx';
import { nicheWord } from './Home.jsx';
import Picker from '../ui/Picker.jsx';
import { Mark } from '../ui/Brand.jsx';

const FRAMING_HINTS = {
  closeup: 'Just your face',
  medium: 'Chest up, for talking',
  waist_up: 'Hands and props in view',
  full_body: 'Head to toe',
};

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
export default function Script({ shoot, user, health, onStart, onBack }) {
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [planId, setPlanId] = useState(null);
  const [script, setScript] = useState(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(null); // shot index being edited

  useEffect(warmUpCamera, []);

  useEffect(() => {
    let alive = true;
    setState('loading');
    setEditing(null);
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
      <div className="studio">
        <main className="screen">
          <BackBar onBack={onBack} title="Your script" />
          <Writing idea={shoot.idea} niche={nicheWord(user?.niche)} />
        </main>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="studio">
        <main className="screen with-bar">
          <BackBar onBack={onBack} title="Your script" />
          <div className="big-state">
            <h1>The script writer is busy</h1>
            <p className="muted" style={{ fontSize: 17 }}>
              We couldn’t write your script just now. Try again in a moment, or write the lines yourself.
            </p>
            <p className="small muted">{error}</p>
            <button className="link strong" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
              Change my idea
            </button>
          </div>
          <div className="action-bar">
            <button
              className="secondary"
              onClick={() => {
                setScript(fallbackScript(shoot));
                setState('ready');
              }}
            >
              Write it myself
            </button>
            <button className="primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        </main>
      </div>
    );
  }

  const totalSeconds = script.shots.reduce((n, s) => n + (Number(s.duration_seconds) || 0), 0);
  const tips = [
    script.lighting && { glyph: 'light', text: script.lighting.suggestion, avoid: script.lighting.avoid },
    script.background && { glyph: 'frame', text: script.background.suggestion, avoid: script.background.avoid },
  ].filter(Boolean);

  return (
    <div className="studio">
      <main className="screen with-bar">
        <BackBar
          onBack={onBack}
          title="Your script"
          right={
            health?.scripts && (
              <button className="link strong" onClick={() => setAttempt((n) => n + 1)}>
                Rewrite
              </button>
            )
          }
        />
        <div className="stack">
          <textarea
            className="title-input"
            value={script.title}
            rows={2}
            onChange={(e) => setScript((s) => ({ ...s, title: e.target.value.replace(/\n/g, ' ') }))}
            aria-label="Reel title"
          />
          <p className="muted">
            {script.shots.length} {script.shots.length === 1 ? 'shot' : 'shots'} · {totalSeconds} sec
            {script.trend_used ? ` · rides “${script.trend_used}”` : ''}
          </p>
        </div>

        <ol className="shot-list">
          {script.shots.map((shot, i) => (
            <li key={i} className="shot-row">
              <FramingTile framing={shot.framing} />
              {editing === i ? (
                <ShotEditor
                  shot={shot}
                  index={i}
                  canRemove={script.shots.length > 1}
                  onChange={(patch) => updateShot(i, patch)}
                  onRemove={() => {
                    setScript((s) => ({ ...s, shots: s.shots.filter((_, j) => j !== i) }));
                    setEditing(null);
                  }}
                  onDone={() => setEditing(null)}
                />
              ) : (
                <>
                  <div className="grow">
                    <p className="eyebrow">
                      Shot {i + 1} · {shot.title}
                    </p>
                    <p className="say">{shot.line || <em className="muted">No line yet. Tap edit to add one.</em>}</p>
                    <p className="meta">
                      {framingFor(shot.framing).label} · {shot.duration_seconds} sec{shot.direction ? ` · ${shot.direction}` : ''}
                    </p>
                  </div>
                  <button className="icon-btn bare" onClick={() => setEditing(i)} aria-label={`Edit shot ${i + 1}`}>
                    <Glyph name="edit" size={22} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
        {script.shots.length < 6 && (
          <button
            className="secondary"
            onClick={() => {
              setScript((s) => ({
                ...s,
                shots: [...s.shots, { title: `Shot ${s.shots.length + 1}`, line: '', framing: 'medium', pose: 'neutral', direction: '', duration_seconds: 5 }],
              }));
              setEditing(script.shots.length);
            }}
          >
            <Glyph name="plus" size={20} /> Add a shot
          </button>
        )}

        {tips.length > 0 && (
          <ul className="tips">
            {tips.map((t) => (
              <li key={t.glyph}>
                <Glyph name={t.glyph} size={22} />
                <span>
                  {t.text}
                  {t.avoid?.length > 0 && <span className="muted"> Avoid {t.avoid.join(', ')}.</span>}
                </span>
              </li>
            ))}
          </ul>
        )}

        {script.caption && (
          <p className="small muted">
            Caption: {script.caption} {Array.isArray(script.hashtags) ? script.hashtags.join(' ') : ''}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="action-bar">
          <button className="primary" onClick={start} disabled={saving}>
            {saving ? 'Saving…' : 'Start shooting'}
          </button>
        </div>
      </main>
    </div>
  );
}

function ShotEditor({ shot, index, canRemove, onChange, onRemove, onDone }) {
  return (
    <div className="shot-edit">
      <input value={shot.title} onChange={(e) => onChange({ title: e.target.value })} aria-label={`Shot ${index + 1} name`} />
      <textarea value={shot.line} rows={3} maxLength={1500} onChange={(e) => onChange({ line: e.target.value })} aria-label="What you say" autoFocus />
      <div className="row">
        <Picker
          label="Framing"
          title="How close is the camera?"
          value={shot.framing}
          options={Object.entries(FRAMINGS).map(([key, f]) => ({ value: key, label: f.label, hint: FRAMING_HINTS[key] }))}
          onChange={(v) => onChange({ framing: v })}
        />
        <Picker
          label="Length"
          title="How long is this shot?"
          value={Number(shot.duration_seconds)}
          options={[...new Set([3, 5, 8, 10, 15, 20, 30, 45, 60, Number(shot.duration_seconds)])].sort((a, b) => a - b).map((n) => ({ value: n, label: `${n} sec` }))}
          onChange={(v) => onChange({ duration_seconds: v })}
        />
      </div>
      <div className="row between">
        {canRemove ? (
          <button className="link" onClick={onRemove}>
            Remove shot
          </button>
        ) : (
          <span />
        )}
        <button className="primary" style={{ minHeight: 44 }} onClick={onDone}>
          <Glyph name="check" size={18} /> Done
        </button>
      </div>
    </div>
  );
}

// What the script writer is doing, step by step, timed to how long each usually takes.
const WRITING_STEPS = [
  [0, () => 'Reading your idea'],
  [1500, (niche) => `Checking what’s trending in ${niche}`],
  [4000, () => 'Writing your lines'],
  [8000, () => 'Planning your shots'],
];

function Writing({ idea, niche }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timers = WRITING_STEPS.slice(1).map(([at], i) => setTimeout(() => setStep(i + 1), at));
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <div className="big-state" role="status" aria-live="polite">
      <div className="writing-mark" aria-hidden="true">
        <span className="loader" />
        <Mark />
      </div>
      {idea && <h2 style={{ fontSize: 28 }}>“{idea}”</h2>}
      <ol className="steps">
        {WRITING_STEPS.map(([, label], i) => (
          <li key={i} className={i < step ? 'done' : i === step ? 'now' : 'muted'}>
            {label(niche)}
          </li>
        ))}
      </ol>
      <p className="small muted">Usually about 10 seconds</p>
    </div>
  );
}
