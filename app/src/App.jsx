import { useEffect, useState } from 'react';
import { getHealth, nextShot, planShoot, uploadTake } from './api.js';

const LANGUAGES = ['Hinglish', 'Hindi', 'English', 'Tamil', 'Telugu', 'Bengali', 'Marathi', 'Kannada'];

export default function App() {
  const [health, setHealth] = useState(null);
  const [planned, setPlanned] = useState(null); // { planId, plan }

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ ok: false }));
  }, []);

  return (
    <main>
      <header>
        <h1>Darpan</h1>
        <p className="tagline">Your reel coach, right in your pocket.</p>
      </header>

      {health?.ok && !health.director && <QuickTake />}
      {health?.director && !planned && <IdeaForm onPlanned={setPlanned} />}
      {planned && <Shoot planned={planned} onRestart={() => setPlanned(null)} />}

      <footer>
        Server: {health ? (health.ok ? 'connected' : 'unavailable') : 'checking…'}
        {health?.ok && !health.director && ' · AI director not set up'}
      </footer>
    </main>
  );
}

function IdeaForm({ onPlanned }) {
  const [idea, setIdea] = useState('');
  const [language, setLanguage] = useState('Hinglish');
  const [durationSeconds, setDurationSeconds] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onPlanned(await planShoot({ idea, language, durationSeconds }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <label>
        What's your reel about?
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="e.g. 3 street foods to try in Indore under ₹100"
          maxLength={500}
          rows={3}
          required
        />
      </label>
      <div className="row">
        <label>
          Language
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
          </select>
        </label>
        <label>
          Length
          <select value={durationSeconds} onChange={(e) => setDurationSeconds(Number(e.target.value))}>
            {[15, 30, 60, 90].map((s) => <option key={s} value={s}>{s}s</option>)}
          </select>
        </label>
      </div>
      <button className="primary" disabled={busy || !idea.trim()}>
        {busy ? 'Your director is planning…' : 'Plan my shoot'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Shoot({ planned, onRestart }) {
  const { planId, plan } = planned;
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  const [takes, setTakes] = useState({});
  const [suggestion, setSuggestion] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onNext() {
    setBusy(true);
    setError('');
    try {
      const shotsDone = Object.keys(takes).map(Number);
      setSuggestion(await nextShot({ planId, plan: planId ? undefined : plan, shotsDone }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="shoot">
      {plan.title && <h2>{plan.title}</h2>}
      {plan.hook && <p className="hook">Hook: {plan.hook}</p>}

      {/* The director didn't return the expected shape; show what it said. */}
      {shots.length === 0 && <pre className="card raw">{JSON.stringify(plan, null, 2)}</pre>}

      <ol className="shots">
        {shots.map((shot, i) => (
          <li key={i} className="card">
            <ShotDetails shot={shot} />
            <TakeButton
              label={takes[i] ? 'Retake' : 'Record this shot'}
              upload={(file) => uploadTake(file, { planId, plan, shotIndex: i })}
              onDone={(take) => setTakes((t) => ({ ...t, [i]: take }))}
            />
            {takes[i] && <Review take={takes[i]} />}
          </li>
        ))}
      </ol>

      <button onClick={onNext} disabled={busy}>
        {busy ? 'Thinking…' : 'What should I shoot next?'}
      </button>
      {error && <p className="error">{error}</p>}
      {suggestion?.shot && (
        <div className="card">
          <ShotDetails shot={suggestion.shot} />
          {suggestion.why && <p className="muted">{suggestion.why}</p>}
        </div>
      )}

      {(plan.caption || plan.hashtags) && (
        <div className="card">
          {plan.caption && <p>{plan.caption}</p>}
          {Array.isArray(plan.hashtags) && <p className="muted">{plan.hashtags.join(' ')}</p>}
        </div>
      )}

      <button className="link" onClick={onRestart}>Start a new reel</button>
    </section>
  );
}

function ShotDetails({ shot }) {
  return (
    <>
      <h3>
        {shot.title}
        {shot.duration_seconds && <span className="muted"> · {shot.duration_seconds}s</span>}
      </h3>
      {shot.framing && <p><strong>Frame:</strong> {shot.framing}</p>}
      {shot.say && <p><strong>Say:</strong> “{shot.say}”</p>}
      {Array.isArray(shot.tips) && shot.tips.length > 0 && (
        <ul className="tips">{shot.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
      )}
    </>
  );
}

function Review({ take }) {
  const r = take.review;
  if (!r) return <p className="muted">Saved: {take.durationSeconds?.toFixed(1)}s</p>;
  return (
    <div className={`review ${r.verdict === 'retake' ? 'retake' : 'keep'}`}>
      <strong>{r.verdict === 'retake' ? 'Try once more' : 'Nice, keep it!'}</strong>
      {r.praise?.map((p, i) => <p key={`p${i}`}>👍 {p}</p>)}
      {r.fixes?.map((f, i) => <p key={`f${i}`}>👉 {f}</p>)}
      {r.next_step && <p className="muted">{r.next_step}</p>}
    </div>
  );
}

function TakeButton({ label, upload, onDone }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  async function onPick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      onDone(await upload(file));
    } catch (err) {
      setError(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <label className="record">
        {uploading ? 'Uploading…' : label}
        <input type="file" accept="video/*" capture="user" onChange={onPick} disabled={uploading} hidden />
      </label>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function QuickTake() {
  const [take, setTake] = useState(null);
  return (
    <>
      <TakeButton label="Record a take" upload={(file) => uploadTake(file)} onDone={setTake} />
      {take && (
        <p className="muted">
          Got it: {take.durationSeconds?.toFixed(1)}s, {take.width}×{take.height}
        </p>
      )}
    </>
  );
}
