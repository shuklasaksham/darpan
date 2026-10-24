import { useEffect, useRef, useState } from 'react';
import { getReel, makeReel, reuploadTake } from '../api.js';
import { goPro } from './Plan.jsx';

/**
 * Once every shot has a kept take: review them, choose captions, make the reel,
 * watch progress, then play, download or share the result.
 */
export default function Reel({ shots, kept, onBack, onDone }) {
  const [captions, setCaptions] = useState(true);
  const [phase, setPhase] = useState('review'); // review | making | done | error
  const [status, setStatus] = useState({ progress: 0, stage: '' });
  const [error, setError] = useState('');
  const [reelId, setReelId] = useState(null);
  const [needsPro, setNeedsPro] = useState(false);
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  async function start() {
    setPhase('making');
    setError('');
    setStatus({ progress: 0, stage: 'Sending your takes' });
    const takeIds = shots.map((_, i) => kept[i].takeId);
    try {
      let created;
      try {
        created = await makeReel({ takeIds, captions });
      } catch (err) {
        if (err.status !== 409 || !err.body?.missing) throw err;
        // The server lost some files (its disk is wiped on restart); this phone still has them.
        setStatus({ progress: 0, stage: 'Re-sending some takes' });
        for (const id of err.body.missing) {
          const entry = Object.values(kept).find((k) => k.takeId === id);
          if (!entry) throw new Error('A take is missing. Record that shot again.');
          await reuploadTake(id, entry.blob);
        }
        created = await makeReel({ takeIds, captions });
      }
      setReelId(created.reelId);
      await poll(created.reelId);
    } catch (err) {
      if (cancelled.current) return;
      setNeedsPro(err.status === 402);
      setError(err.message);
      setPhase('error');
    }
  }

  async function poll(id) {
    for (;;) {
      if (cancelled.current) return;
      const s = await getReel(id);
      setStatus({ progress: s.progress ?? 0, stage: s.stage ?? '' });
      if (s.status === 'done') return setPhase('done');
      if (s.status === 'error') throw new Error(s.error || 'Making the reel failed. Try again.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return (
    <div className="reel-screen">
      {phase === 'review' && (
        <>
          <header className="reel-header">
            <h2>Your takes</h2>
            <p className="muted">Every shot has a take. Ready to put them together?</p>
          </header>
          <ol className="kept-takes">
            {shots.map((shot, i) => (
              <li key={i}>
                <video src={kept[i].url} muted playsInline loop controls preload="metadata" />
                <div>
                  <strong>
                    {i + 1}. {shot.title}
                  </strong>
                  {kept[i].result?.score != null && <p className="muted">Score {kept[i].result.score}</p>}
                </div>
              </li>
            ))}
          </ol>
          <label className="switch">
            <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
            <span className="track" aria-hidden="true" />
            <span>
              Hinglish captions
              <small className="muted">Filler words like "umm" are left out</small>
            </span>
          </label>
          <div className="reel-actions">
            <button className="primary" onClick={start}>
              Make my reel
            </button>
            <button className="link" onClick={onBack}>
              Back to shots
            </button>
          </div>
        </>
      )}

      {phase === 'making' && (
        <div className="making">
          <h2>Making your reel</h2>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(status.progress * 100)}>
            <div style={{ width: `${Math.round(status.progress * 100)}%` }} />
          </div>
          <p>
            {Math.round(status.progress * 100)}% · {status.stage}
          </p>
          <p className="muted">Trimming each take, adding captions and joining them. Keep this screen open.</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="making">
          <p className="error">{error}</p>
          <div className="reel-actions">
            {needsPro && (
              <button className="primary" onClick={() => goPro(setError)}>
                Go Pro for unlimited reels
              </button>
            )}
            <button className="primary" onClick={start}>
              Try again
            </button>
            <button className="link" onClick={() => setPhase('review')}>
              Back
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && reelId && <Finished reelId={reelId} onDone={onDone} />}
    </div>
  );
}

function Finished({ reelId, onDone }) {
  const src = `/api/reels/${reelId}/file`;
  const [file, setFile] = useState(null);
  const [message, setMessage] = useState('');

  // Fetch the file up front so Share opens instantly (browsers only allow the
  // share sheet right after a tap).
  useEffect(() => {
    let alive = true;
    fetch(src)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('download failed'))))
      .then((blob) => alive && setFile(new File([blob], `darpan-reel-${reelId}.mp4`, { type: 'video/mp4' })))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [src, reelId]);

  const canShare = Boolean(file && navigator.canShare?.({ files: [file] }));

  async function share() {
    setMessage('');
    try {
      await navigator.share({ files: [file], title: 'My reel', text: 'Shot with Darpan' });
    } catch (err) {
      if (err.name !== 'AbortError') setMessage("Couldn't open sharing. Download it instead.");
    }
  }

  return (
    <div className="finished">
      <h2>Your reel is ready</h2>
      <video src={src} className="final-video" controls playsInline autoPlay />
      <div className="reel-actions">
        <a className="button primary" href={`${src}?download=1`} download={`darpan-reel-${reelId}.mp4`}>
          Download
        </a>
        <button onClick={share} disabled={!file || !canShare}>
          {file ? 'Share' : 'Preparing…'}
        </button>
      </div>
      {file && !canShare && <p className="muted">This browser can't share videos directly. Download it, then post it from your gallery.</p>}
      {message && <p className="error">{message}</p>}
      <button className="link" onClick={onDone}>
        Start a new reel
      </button>
    </div>
  );
}
