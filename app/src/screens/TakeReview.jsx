import { useEffect, useRef, useState } from 'react';
import Glyph from '../ui/Glyph.jsx';
import { readPref, writePref } from '../ui/parts.jsx';

const BREAKDOWN = [
  ['hook', 'Hook'],
  ['voice', 'Voice'],
  ['eye', 'Eye contact'],
];

/**
 * After a take: checking it (camera off), then the score, its breakdown and
 * the director's notes. Offline takes wait on the phone and retry.
 */
export default function TakeReview({ take, shot, shotIndex, isLast, speaker, language, onRetake, onKeep, onRetry }) {
  const videoRef = useRef(null);
  const [withSound, setWithSound] = useState(false);
  const [mode, setMode] = useState(() => readPref('notesMode', 'read')); // read | listen
  const result = take.result;

  // Back online: send the waiting take by itself.
  useEffect(() => {
    if (take.status !== 'offline') return;
    window.addEventListener('online', onRetry);
    return () => window.removeEventListener('online', onRetry);
  }, [take.status, onRetry]);

  const label = `Shot ${shotIndex + 1}${shot?.title ? ` · ${shot.title}` : ''}`;
  const takeLabel = result?.takeNumber ? `Take ${result.takeNumber}` : null;

  return (
    <div className="review studio" role="dialog" aria-modal="true" aria-label="Your take">
      <div className="review-media">
        <video ref={videoRef} src={take.url} playsInline autoPlay muted={!withSound} loop />
        {!withSound && take.status === 'done' && (
          <button
            className="icon-btn ink play-center"
            onClick={() => {
              setWithSound(true);
              setMode('read');
              if (videoRef.current) videoRef.current.currentTime = 0;
            }}
            aria-label="Play with sound"
            style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 56, height: 56, background: 'rgb(10 10 10 / 0.6)', color: '#fff' }}
          >
            <Glyph name="play" />
          </button>
        )}
        <div className="over">
          <button className="cam-btn" onClick={onRetake} aria-label="Back to the camera" disabled={take.status === 'uploading'}>
            <Glyph name="back" size={22} />
          </button>
          <span className="tag ink" style={{ fontSize: 13, padding: '6px 12px' }}>
            {label}
            {takeLabel ? ` · ${takeLabel}` : ''}
          </span>
        </div>
      </div>

      <div className="review-body">
        {take.status === 'uploading' && <Checking take={take} />}

        {take.status === 'offline' && (
          <div className="stack">
            <h2>You’re offline</h2>
            <p className="muted">Your take is safe on this phone. It uploads by itself as soon as you’re back online.</p>
          </div>
        )}

        {take.status === 'error' && (
          <div className="stack">
            <h2>We couldn’t check this take</h2>
            <p className="error">{take.error}</p>
          </div>
        )}

        {take.status === 'done' && (
          <>
            <div className="row between" style={{ alignItems: 'baseline' }}>
              <span className="score">
                {(result.score / 10).toFixed(1)}
                <small>/10</small>
              </span>
              <BestOf result={result} />
            </div>
            {result.breakdown && <Breakdown breakdown={result.breakdown} />}
            {result.notes?.length ? (
              <Notes
                result={result}
                mode={mode}
                onMode={(m) => {
                  setMode(m);
                  writePref('notesMode', m);
                  if (m === 'listen') setWithSound(false);
                }}
                speaker={speaker}
                language={language}
              />
            ) : (
              <>
                <h2>That’s a keeper</h2>
                <p className="muted">{result.praise || 'Nothing to fix. Keep it and move on.'}</p>
              </>
            )}
          </>
        )}
      </div>

      <div className="action-bar">
        {take.status === 'offline' || take.status === 'error' ? (
          <>
            <button className="secondary" onClick={onRetake}>
              Re-shoot
            </button>
            <button className="primary" onClick={onRetry}>
              Retry upload
            </button>
          </>
        ) : (
          <>
            <button className="secondary" onClick={onRetake} disabled={take.status === 'uploading'}>
              Re-shoot <Glyph name="reshoot" size={20} />
            </button>
            <button className="primary" onClick={onKeep} disabled={take.status !== 'done'}>
              {isLast ? 'Keep & finish' : 'Keep & next'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The notes, read on screen or heard out loud: one or the other, never both.
 * Listening reads them one after another; switching to Read stops the voice.
 */
function Notes({ result, mode, onMode, speaker, language }) {
  const [playing, setPlaying] = useState(-1); // index being spoken
  const runRef = useRef(0);
  const notes = result.notes;
  const code = language === 'English' ? 'en-IN' : 'hi-IN';

  async function listen() {
    const run = ++runRef.current;
    speaker?.stop();
    for (const [i, n] of notes.entries()) {
      if (runRef.current !== run) return;
      setPlaying(i);
      await speaker?.say(n.note_spoken || n.note, code);
    }
    if (runRef.current === run) setPlaying(-1);
  }

  useEffect(() => {
    if (mode === 'listen') listen();
    return () => {
      runRef.current++;
      speaker?.stop();
      setPlaying(-1);
    };
  }, [mode]);

  return (
    <section className="stack">
      <div className="row between">
        <h2>{notes.length === 1 ? 'One thing to try' : `${notes.length} things to try`}</h2>
        <div className="segmented" role="radiogroup" aria-label="How to get your notes">
          <button role="radio" aria-checked={mode === 'read'} onClick={() => onMode('read')}>
            Read
          </button>
          <button role="radio" aria-checked={mode === 'listen'} onClick={() => onMode('listen')}>
            <Glyph name="speaker" size={16} /> Listen
          </button>
        </div>
      </div>
      {mode === 'read' ? (
        <>
          {result.praise && <p className="muted">{result.praise}</p>}
          <ul className="notes">
            {notes.map((n, i) => (
              <li key={i}>{n.note}</li>
            ))}
          </ul>
        </>
      ) : (
        <div className="listening-card" aria-live="polite">
          <span className={`bars ${playing >= 0 ? 'on' : ''}`} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="grow">{playing >= 0 ? `Note ${playing + 1} of ${notes.length}` : 'Done'}</span>
          <button className="link strong" onClick={listen}>
            {playing >= 0 ? 'Start over' : 'Play again'}
          </button>
        </div>
      )}
    </section>
  );
}

function BestOf({ result }) {
  if (!result.takeNumber || result.takeNumber < 2) return null;
  const best = result.score >= (result.bestScore ?? 0);
  return (
    <span className="small muted">
      {best ? `Best of ${result.takeNumber} takes` : `Your best is ${(result.bestScore / 10).toFixed(1)}`}
    </span>
  );
}

function Breakdown({ breakdown }) {
  const scored = BREAKDOWN.filter(([key]) => breakdown[key] != null);
  const lowest = Math.min(...scored.map(([key]) => breakdown[key]));
  return (
    <div className="breakdown">
      {scored.map(([key, name]) => (
        <span key={key} className={breakdown[key] === lowest && lowest < 8 ? 'low' : ''}>
          {name} <b>{breakdown[key]}</b>
        </span>
      ))}
    </div>
  );
}

/** What happens while the take is checked: upload (real progress), then listening and notes. */
function Checking({ take }) {
  const [since, setSince] = useState(null);
  const uploaded = (take.progress ?? 0) >= 1;
  useEffect(() => {
    if (uploaded && since == null) setSince(Date.now());
  }, [uploaded, since]);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const writing = since != null && Date.now() - since > 4000;
  const mb = take.blob?.size ? (take.blob.size / 1e6).toFixed(1) : null;

  return (
    <div className="checking">
      <h2>Checking your take</h2>
      <ol className="steps">
        <li className={uploaded ? 'done' : 'now'}>
          {uploaded ? `Uploaded${mb ? ` · ${mb} MB` : ''}` : `Uploading · ${Math.round((take.progress ?? 0) * 100)}%`}
        </li>
        <li className={writing ? 'done' : uploaded ? 'now' : ''}>Listening to your words</li>
        <li className={writing ? 'now' : ''}>Writing your director’s notes</li>
      </ol>
      <p className="small muted">The camera is off while you wait. This usually takes 5–10 seconds.</p>
    </div>
  );
}
