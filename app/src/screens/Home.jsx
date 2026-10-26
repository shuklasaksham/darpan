import { useEffect, useRef, useState } from 'react';
import { getTrends, transcribe } from '../api.js';
import { pickMimeType, stopStream } from '../media.js';
import { PlanCard } from './Plan.jsx';
import { RecentShoots } from './Recent.jsx';

export const FORMATS = [
  'Talk to camera',
  'Top 3 list',
  'Day in my life',
  'Quick how-to',
  'Before → after',
  'POV skit',
  'Honest review',
  'Storytime',
];
const LANGUAGES = ['Hinglish', 'Hindi', 'English'];
const MAX_VOICE_SECONDS = 60;

function savedLanguage() {
  try {
    return localStorage.getItem('darpan.language') || 'Hinglish';
  } catch {
    return 'Hinglish';
  }
}

export default function Home({ user, health, onShoot, onResume, onLogOut }) {
  const [idea, setIdea] = useState('');
  const [language, setLanguage] = useState(savedLanguage);
  const [cards, setCards] = useState(null); // null while loading
  const firstName = user.name.split(/\s+/)[0];
  // Trend cards come from Claude.
  const trendsOn = Boolean(health?.scripts);

  useEffect(() => {
    try {
      localStorage.setItem('darpan.language', language);
    } catch {}
  }, [language]);

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

  // Whatever is in the box is the idea, word for word.
  const typedIdea = idea.trim();

  return (
    <main>
      <header className="top">
        <div>
          <h2>Namaste, {firstName}</h2>
          <p className="muted">@{user.username}</p>
        </div>
        <button className="link" onClick={onLogOut}>Log out</button>
      </header>

      <PlanCard />

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (typedIdea) onShoot({ idea: typedIdea, format: null, language });
        }}
      >
        <label htmlFor="idea">What's your reel idea?</label>
        <div className="idea-box">
          <textarea
            id="idea"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Type it, or tap the mic and say it"
            maxLength={1000}
            rows={3}
          />
          {health?.voice && (
            <MicButton
              language={language}
              onTranscript={(text) => setIdea((current) => (current.trim() ? `${current.trim()} ${text}` : text))}
            />
          )}
        </div>
        <div className="row between">
          <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">
            {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
          </select>
          <button className="primary" disabled={!typedIdea}>Shoot this idea</button>
        </div>
      </form>

      {trendsOn && (cards === null || cards.length > 0) && (
        <section className="stack">
          <div className="section-title">
            <h3>Trending in your niche</h3>
            <span className="muted">Tap to shoot</span>
          </div>
          <div className="trend-cards">
            {cards === null
              ? [0, 1, 2].map((i) => <div key={i} className="trend-skeleton" aria-hidden="true" />)
              : cards.map((card, i) => (
                  <button
                    key={i}
                    className="trend-card"
                    onClick={() => onShoot({ idea: card.title, format: card.format ?? null, language })}
                  >
                    <strong>{card.title}</strong>
                    {card.why && <p>{card.why}</p>}
                    {card.format && <span className="format">{card.format}</span>}
                  </button>
                ))}
          </div>
        </section>
      )}

      <RecentShoots onResume={onResume} />

      <section className="stack">
        <h3>{typedIdea ? 'Shoot it as…' : 'Or pick a format'}</h3>
        <div className="chips">
          {FORMATS.map((format) => (
            <button
              key={format}
              className="chip"
              onClick={() => onShoot({ idea: typedIdea || null, format, language })}
            >
              {format}
            </button>
          ))}
        </div>
      </section>

    </main>
  );
}

function MicButton({ language, onTranscript }) {
  const [state, setState] = useState('idle'); // idle | recording | sending
  const [error, setError] = useState('');
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
      setError('Allow microphone access to speak your idea.');
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

  const labels = { idle: 'Speak your idea', recording: 'Stop recording', sending: 'Transcribing' };
  return (
    <>
      <button
        type="button"
        className={`mic ${state}`}
        onClick={state === 'recording' ? stopRecording : start}
        disabled={state === 'sending'}
        aria-label={labels[state]}
        title={labels[state]}
      >
        {state === 'sending' ? '…' : <MicIcon />}
      </button>
      {state === 'recording' && <p className="listening">Listening… tap to stop</p>}
      {error && <p className="error">{error}</p>}
    </>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"
      />
    </svg>
  );
}
