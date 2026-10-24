import { useEffect, useState } from 'react';

export default function App() {
  const [health, setHealth] = useState(null);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false }));
  }, []);

  async function onPick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('Uploading…');
    setResult(null);
    const body = new FormData();
    body.append('video', file);
    try {
      const res = await fetch('/api/takes', { method: 'POST', body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      setResult(json);
      setStatus('');
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`);
    }
    e.target.value = '';
  }

  return (
    <main>
      <h1>Darpan</h1>
      <p className="tagline">Your reel coach, right in your pocket.</p>

      <label className="record">
        Record a take
        <input type="file" accept="video/*" capture="user" onChange={onPick} hidden />
      </label>

      {status && <p className="status">{status}</p>}
      {result && (
        <p className="status">
          Got it: {result.durationSeconds?.toFixed(1)}s, {result.width}×{result.height}
        </p>
      )}

      <footer>
        Server: {health ? (health.ok ? 'connected' : 'unavailable') : 'checking…'}
      </footer>
    </main>
  );
}
