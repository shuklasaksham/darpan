import { useEffect, useState } from 'react';
import { logIn, signUp, suggestUsernames } from '../api.js';
import Glyph from '../ui/Glyph.jsx';
import { BackBar } from '../ui/parts.jsx';

const GENDERS = [
  { value: 'woman', label: 'A woman' },
  { value: 'man', label: 'A man' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];
const NICHES = ['Food', 'Fitness', 'Comedy', 'Beauty', 'Tech', 'Money', 'Travel', 'Fashion', 'Education'];
const OTHER = 'Something else';

export default function Auth({ initialMode = 'signup', onSignedIn, onExit }) {
  const [mode, setMode] = useState(initialMode === 'login' ? 'login' : 'signup');
  return mode === 'login' ? (
    <LogIn onSignedIn={onSignedIn} onBack={onExit} onSignUp={() => setMode('signup')} />
  ) : (
    <SignUp onSignedIn={onSignedIn} onBack={onExit} onLogIn={() => setMode('login')} />
  );
}

function Progress({ step }) {
  return (
    <div className="progress-line" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= step ? 'on' : ''} />
      ))}
    </div>
  );
}

function SignUp({ onSignedIn, onBack, onLogIn }) {
  const [step, setStep] = useState('about'); // about | username | pin | confirm
  const [name, setName] = useState('');
  const [gender, setGender] = useState('');
  const [niche, setNiche] = useState('');
  const [nicheDetail, setNicheDetail] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [username, setUsername] = useState('');
  const [taken, setTaken] = useState('');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // "Food: budget street food in Indore" gives the script writer far more to go on than "Food".
  const fullNiche = niche === OTHER ? nicheDetail.trim() : [niche, nicheDetail.trim()].filter(Boolean).join(': ');

  async function loadSuggestions() {
    const { suggestions } = await suggestUsernames(name);
    setSuggestions(suggestions);
    setUsername((current) => (current && !suggestions.includes(current) ? current : suggestions[0] ?? ''));
  }

  async function run(action) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function create(confirmPin) {
    setBusy(true);
    setError('');
    try {
      const { user } = await signUp({ name, gender, niche: fullNiche, username: username.trim(), pin, pinConfirm: confirmPin });
      onSignedIn(user);
    } catch (err) {
      setBusy(false);
      if (err.status === 409) {
        setTaken(username);
        await loadSuggestions().catch(() => {});
        setPin('');
        setPinConfirm('');
        setStep('username');
        return;
      }
      setError(err.message);
    }
  }

  const back = { about: onBack, username: () => setStep('about'), pin: () => setStep('username'), confirm: () => setStep('pin') }[step];

  return (
    <main className="screen with-bar">
      <BackBar onBack={back} title="Create account" strong />
      <Progress step={{ about: 1, username: 2, pin: 3, confirm: 3 }[step]} />

      {step === 'about' && (
        <form
          id="step"
          className="stack loose"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await loadSuggestions();
              setStep('username');
            });
          }}
        >
          <div className="stack tight">
            <h1>Tell us about you</h1>
            <p className="muted">Scripts are written in your voice, for your niche.</p>
          </div>
          <label>
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Priya Sharma or प्रिया शर्मा"
              maxLength={60}
              autoComplete="name"
              required
            />
          </label>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small" style={{ fontWeight: 600, marginBottom: 8 }}>You are</legend>
            <div className="chips">
              {GENDERS.map((g) => (
                <label key={g.value} className="chip">
                  <input type="radio" name="gender" value={g.value} checked={gender === g.value} onChange={() => setGender(g.value)} required />
                  {g.label}
                </label>
              ))}
            </div>
            <p className="hint">Hindi lines use the right verb: “main karti hoon” or “main karta hoon”.</p>
          </fieldset>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small" style={{ fontWeight: 600, marginBottom: 8 }}>What do you make reels about?</legend>
            <div className="chips">
              {[...NICHES, OTHER].map((n) => (
                <label key={n} className="chip">
                  <input type="radio" name="niche" value={n} checked={niche === n} onChange={() => setNiche(n)} required />
                  {n}
                </label>
              ))}
            </div>
            {niche && (
              <input
                value={nicheDetail}
                onChange={(e) => setNicheDetail(e.target.value)}
                placeholder={niche === OTHER ? 'e.g. Marathi comedy, gardening in Delhi' : 'Be specific (optional), e.g. budget street food in Indore'}
                maxLength={160}
                aria-label="Your niche in a few words"
                required={niche === OTHER}
              />
            )}
          </fieldset>
          {error && <p className="error">{error}</p>}
          <p className="small muted">
            Already have an account?{' '}
            <button type="button" className="link strong" onClick={onLogIn} style={{ minHeight: 0, padding: 0 }}>
              Log in
            </button>
          </p>
        </form>
      )}

      {step === 'username' && (
        <form
          id="step"
          className="stack loose"
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            setStep('pin');
          }}
        >
          <div className="stack tight">
            <h1>Pick a username</h1>
            <p className="muted">You’ll log in with it. No email or phone number needed.</p>
          </div>
          <label>
            <span className="row between">
              Username
              {taken && username === taken ? (
                <span className="field-state bad">Taken</span>
              ) : (
                taken && <span className="field-state ok">Free to use</span>
              )}
            </span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
              pattern="[a-z0-9._]{3,20}"
              title="3–20 lowercase letters, numbers, dots or underscores"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
              required
            />
            {taken && username === taken && (
              <span className="hint">Someone already has “{taken}”. Pick one below or add a word.</span>
            )}
          </label>
          {suggestions.length > 0 && (
            <div className="stack">
              <span className="small" style={{ fontWeight: 600 }}>Suggestions</span>
              <div className="chips">
                {suggestions
                  .filter((s) => s !== taken)
                  .map((s) => (
                    <button type="button" key={s} className={`chip ${username === s ? 'selected' : ''}`} onClick={() => setUsername(s)}>
                      {s}
                    </button>
                  ))}
              </div>
            </div>
          )}
          {/[^\x00-\x7F]/.test(name) && (
            <p className="hint">Typed your name in Hindi? It’s spelled the way Indian names usually are in English.</p>
          )}
        </form>
      )}

      {step === 'pin' && (
        <PinStep
          key="pin"
          title="Set a 4-digit PIN"
          sub={`For ${username}`}
          hint={error || 'Type it twice. 5 wrong tries lock the account for 15 minutes.'}
          bad={Boolean(error)}
          value={pin}
          onChange={(v) => {
            setError('');
            setPin(v);
          }}
          onComplete={() => setTimeout(() => setStep('confirm'), 150)}
        />
      )}
      {step === 'confirm' && (
        <PinStep
          key="confirm"
          title="Confirm your PIN"
          sub={`For ${username}`}
          hint={error || 'Type the same 4 digits again.'}
          bad={Boolean(error)}
          value={pinConfirm}
          onChange={(v) => {
            setError('');
            setPinConfirm(v);
          }}
          onComplete={(v) => {
            if (v !== pin) {
              setError('Those didn’t match. Type your new PIN again.');
              setPinConfirm('');
              setPin('');
              setTimeout(() => setStep('pin'), 900);
              return;
            }
            create(v);
          }}
        />
      )}

      <div className="action-bar">
        {step === 'about' && (
          <button className="primary" form="step" disabled={busy || !name.trim() || !gender || !fullNiche}>
            {busy ? 'One moment…' : 'Continue'}
          </button>
        )}
        {step === 'username' && (
          <button className="primary" form="step" disabled={!username || username === taken}>
            Continue
          </button>
        )}
        {(step === 'pin' || step === 'confirm') && (
          <button className="primary" disabled={busy || pinConfirm.length !== 4} onClick={() => create(pinConfirm)}>
            {busy ? 'Creating your account…' : 'Create my account'}
          </button>
        )}
      </div>
    </main>
  );
}

function PinStep({ title, sub, hint, bad = false, value, onChange, onComplete }) {
  return (
    <div className="stack loose">
      <div className="stack tight">
        <h1>{title}</h1>
        <p className="muted">{sub}</p>
      </div>
      <PinPad value={value} onChange={onChange} onComplete={onComplete} bad={bad} />
      <p className={`small center-text ${bad ? 'field-state bad' : 'muted'}`} role={bad ? 'alert' : undefined}>
        {hint}
      </p>
    </div>
  );
}

/** Four dots and a number pad; a hardware keyboard works too. */
function PinPad({ value, onChange, onComplete, bad = false }) {
  const press = (key) => {
    if (key === 'del') return onChange(value.slice(0, -1));
    if (value.length >= 4) return;
    const next = value + key;
    onChange(next);
    if (next.length === 4) onComplete?.(next);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="stack loose">
      <div className={`pin-dots ${bad ? 'bad' : ''}`} aria-label={`${value.length} of 4 digits entered`} role="status">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={i < value.length ? 'on' : ''} />
        ))}
      </div>
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'blank', '0', 'del'].map((k) =>
          k === 'blank' ? (
            <button key={k} type="button" className="blank" tabIndex={-1} aria-hidden="true" />
          ) : (
            <button key={k} type="button" className={k === 'del' ? 'del' : ''} onClick={() => press(k)} aria-label={k === 'del' ? 'Delete' : k}>
              {k === 'del' ? 'Delete' : k}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function LogIn({ onSignedIn, onBack, onSignUp }) {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lockedFor, setLockedFor] = useState(0); // seconds

  useEffect(() => {
    if (lockedFor <= 0) return;
    const id = setTimeout(() => setLockedFor((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [lockedFor]);

  async function submit(code = pin) {
    if (!username || code.length !== 4) return;
    setBusy(true);
    setError('');
    try {
      const { user } = await logIn(username.trim(), code);
      onSignedIn(user);
    } catch (err) {
      if (err.status === 423) setLockedFor(err.body?.retryAfterSeconds ?? 900);
      const left = err.body?.attemptsLeft;
      setError(
        left ? `Wrong PIN. ${left} more ${left === 1 ? 'try' : 'tries'} before a 15-minute lock.` : err.status === 401 ? 'Wrong username or PIN.' : err.message,
      );
      setPin('');
      setBusy(false);
    }
  }

  if (lockedFor > 0) {
    return (
      <main className="screen with-bar">
        <BackBar onBack={onBack} title="Log in" strong />
        <div className="big-state">
          <h1>Locked for 15 minutes</h1>
          <p className="muted">5 wrong PINs in a row. This keeps your account safe. You can try again when the timer ends.</p>
          <p className="lock-timer" role="timer">
            {Math.floor(lockedFor / 60)}:{String(lockedFor % 60).padStart(2, '0')}
          </p>
          <p className="muted">minutes left</p>
        </div>
        <div className="action-bar">
          <a className="button secondary" href="/contact">
            Get help with my PIN
          </a>
          <button className="primary" onClick={onBack}>
            Back to start
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="screen with-bar">
      <BackBar onBack={onBack} title="Log in" strong />
      <div className="stack tight">
        <h1>Welcome back</h1>
        <p className="muted">Log in with your username and PIN.</p>
      </div>
      <label>
        Username
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          required
        />
      </label>
      <div className="stack">
        <span className="small" style={{ fontWeight: 600 }}>PIN</span>
        <PinPad
          value={pin}
          bad={Boolean(error)}
          onChange={(v) => {
            setError('');
            setPin(v);
          }}
          onComplete={(v) => submit(v)}
        />
        {error && (
          <p className="small field-state bad center-text" role="alert">
            <Glyph name="alert" size={16} className="inline" /> {error}
          </p>
        )}
      </div>
      <div className="row between">
        <a className="small muted" href="/contact">Forgot your PIN?</a>
        <button className="link strong" onClick={onSignUp}>Create an account</button>
      </div>
      <div className="action-bar">
        <button className="primary" disabled={busy || !username || pin.length !== 4} onClick={() => submit()}>
          {busy ? 'Checking…' : 'Log in'}
        </button>
      </div>
    </main>
  );
}
