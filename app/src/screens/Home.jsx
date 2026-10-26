import { useEffect, useRef, useState } from 'react';
import { getTrends, posterUrl, transcribe } from '../api.js';
import { pickMimeType, stopStream } from '../media.js';
import { resumeState, shootProgress } from './Recent.jsx';
import { Wordmark } from '../ui/Brand.jsx';
import Glyph from '../ui/Glyph.jsx';
import { Poster } from '../ui/parts.jsx';
import Picker from '../ui/Picker.jsx';

export const LANGUAGE_OPTIONS = [
  { value: 'Hinglish', label: 'Hinglish', hint: 'Hindi and English, in Roman letters' },
  { value: 'Hindi', label: 'Hindi', hint: 'देवनागरी में' },
  { value: 'English', label: 'English', hint: 'Simple Indian English' },
];
const MAX_VOICE_SECONDS = 60;
const CARD_GLYPHS = ['reel', 'idea', 'shoot', 'light', 'frame'];

export function savedLanguage() {
  try {
    return localStorage.getItem('darpan.language') || 'Hinglish';
  } catch {
    return 'Hinglish';
  }
}

export function saveLanguage(language) {
  try {
    localStorage.setItem('darpan.language', language);
  } catch {}
}

/** "Food: budget street food in Indore" -> "food" */
export const nicheWord = (niche = '') => niche.split(':')[0].trim().toLowerCase() || 'your niche';

export default function Home({ user, health, shoots, onShoot, onResume, onAccount }) {
  const [idea, setIdea] = useState('');
  const [language, setLanguage] = useState(savedLanguage);
  const [cards, setCards] = useState(null); // null while loading
  const [listening, setListening] = useState(false);
  const firstName = user.name.split(/\s+/)[0];
  const trendsOn = Boolean(health?.scripts);
  const firstTime = shoots !== null && shoots.length === 0;
  const unfinished = (shoots ?? []).find((s) => {
    const p = shootProgress(s);
    return p.kept > 0 && s.reel?.status !== 'done' && Date.now() - new Date(s.createdAt) < 24 * 3600e3;
  });

  useEffect(() => saveLanguage(language), [language]);

  useEffect(() => {
    if (!trendsOn) return;
    let alive = true;
    setCards(null);
    getTrends(language)
      .then(({ cards: list }) => alive && setCards(list ?? []))
      .catch(() => alive && setCards([]));
    return () => {
      alive = false;
    };
  }, [trendsOn, language]);

  const typedIdea = idea.trim();
  const submit = (e) => {
    e.preventDefault();
    if (typedIdea) onShoot({ idea: typedIdea, format: null, language });
  };

  return (
    <main className="screen with-tabs">
      <header className="home-top">
        <Wordmark />
        <button className="avatar" onClick={onAccount} aria-label="Your account">
          {firstName[0]?.toUpperCase()}
        </button>
      </header>

      {unfinished && <ContinueCard shoot={unfinished} onResume={onResume} />}

      <h1 style={{ fontSize: 34 }}>{firstTime ? `Let’s make your first reel, ${firstName}` : `What’s the reel today, ${firstName}?`}</h1>

      <form className="stack" onSubmit={submit}>
        <div className={`idea-box ${listening ? 'listening' : ''}`}>
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder={listening ? 'Listening… bolte rahiye' : 'Type your idea, or tap the mic and say it'}
            maxLength={1000}
            rows={3}
            aria-label="Your reel idea"
          />
          <div className="row">
            <Picker variant="inline" label="Script language" value={language} options={LANGUAGE_OPTIONS} onChange={setLanguage} />
            {health?.voice && (
              <MicButton
                language={language}
                onListening={setListening}
                onTranscript={(text) => setIdea((current) => (current.trim() ? `${current.trim()} ${text}` : text))}
              />
            )}
          </div>
        </div>
        <button className="primary block" disabled={!typedIdea || listening}>
          {listening ? 'Listening…' : 'Write my script'} {!listening && <Glyph name="next" size={20} />}
        </button>
      </form>

      {firstTime && (
        <section className="first-reel">
          <div className="row between">
            <h3>Your first reel in 3 steps</h3>
            <span className="small muted">0 of 3</span>
          </div>
          <ol className="steps">
            <li className="now">Say your idea, in any language</li>
            <li>Shoot 1–3 short shots with your coach</li>
            <li>Save it and post</li>
          </ol>
        </section>
      )}

      {trendsOn && (cards === null || cards.length > 0) && (
        <section className="stack">
          <div className="section-head">
            <h2>Trending in {nicheWord(user.niche)}</h2>
          </div>
          <div className="rail" role="list">
            {cards === null
              ? [0, 1, 2].map((i) => <div key={i} className="trend-card skeleton" aria-hidden="true" />)
              : cards.map((card, i) => (
                  <button
                    key={i}
                    role="listitem"
                    className="trend-card"
                    onClick={() => onShoot({ idea: card.title, format: card.format ?? null, language })}
                  >
                    <Glyph name={CARD_GLYPHS[i % CARD_GLYPHS.length]} className="bg" />
                    {card.format ? <span className="tag ink">{card.format}</span> : <span />}
                    <span>
                      <strong>{card.title}</strong>
                      {card.why && <small>{card.why}</small>}
                    </span>
                  </button>
                ))}
          </div>
        </section>
      )}
    </main>
  );
}

function ContinueCard({ shoot, onResume }) {
  const p = shootProgress(shoot);
  const next = shoot.script?.shots?.[p.nextIndex]?.title;
  return (
    <button className="continue-card" onClick={() => onResume(resumeState(shoot))}>
      <Poster className="poster" src={p.posterTakeId ? posterUrl(p.posterTakeId) : null} />
      <span className="grow">
        <span className="eyebrow">Continue your shoot</span>
        <strong>{shoot.script?.title || shoot.brief?.idea || 'Your reel'}</strong>
        <span className="small muted">
          {p.ready ? 'All shots kept · next: make your reel' : `${p.kept} of ${p.total} shots kept${next ? ` · next: ${next}` : ''}`}
        </span>
      </span>
      <span className="go">Go</span>
    </button>
  );
}

function MicButton({ language, onTranscript, onListening }) {
  const [state, setState] = useState('idle'); // idle | recording | sending
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const recorderRef = useRef(null);
  const timerRef = useRef(null);
  const unmountedRef = useRef(false);

  useEffect(
    () => () => {
      unmountedRef.current = true;
      stopRecording();
    },
    [],
  );
  useEffect(() => onListening(state === 'recording'), [state]);

  function stopRecording() {
    clearTimeout(timerRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  async function start() {
    setError('');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setBlocked(true);
      return;
    }
    const mimeType = pickMimeType(['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']);
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      stopStream(stream);
      if (unmountedRef.current) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
      if (!blob.size) return setState('idle');
      setState('sending');
      try {
        const { transcript } = await transcribe(blob, language);
        if (transcript) onTranscript(transcript);
        else setError("Didn't catch that. Try again a little closer to the phone.");
      } catch (err) {
        setError(err.message);
      } finally {
        setState('idle');
      }
    };
    recorderRef.current = recorder;
    recorder.start();
    setState('recording');
    timerRef.current = setTimeout(stopRecording, MAX_VOICE_SECONDS * 1000);
  }

  const labels = { idle: 'Speak your idea', recording: 'Stop and use what I said', sending: 'Transcribing' };
  return (
    <>
      {error && <span className="small field-state bad grow">{error}</span>}
      <button
        type="button"
        className={`mic-btn ${state === 'recording' ? 'on' : ''}`}
        onClick={state === 'recording' ? stopRecording : start}
        disabled={state === 'sending'}
        aria-label={labels[state]}
        title={labels[state]}
      >
        {state === 'sending' ? <span className="loader" style={{ width: 20, height: 20, borderWidth: 2 }} /> : state === 'recording' ? <Glyph name="check" /> : <Glyph name="voice" />}
      </button>
      {blocked && <MicBlocked onRetry={() => { setBlocked(false); start(); }} onClose={() => setBlocked(false)} />}
    </>
  );
}

function MicBlocked({ onRetry, onClose }) {
  const iPhone = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Allow the microphone" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Allow the microphone</h2>
        <p className="muted">Darpan needs your mic to hear your idea. Nothing is saved until you shoot.</p>
        <ol className="steps">
          {iPhone ? (
            <>
              <li>Tap aA in the address bar</li>
              <li>Open Website Settings, then Microphone</li>
              <li>Choose Allow, then come back here</li>
            </>
          ) : (
            <>
              <li>Tap the lock at the left of the address bar</li>
              <li>Open Permissions, then Microphone</li>
              <li>Choose Allow, then come back here</li>
            </>
          )}
        </ol>
        <button className="primary block" onClick={onRetry}>Try the mic again</button>
        <button className="link" onClick={onClose}>Type my idea instead</button>
      </div>
    </div>
  );
}
