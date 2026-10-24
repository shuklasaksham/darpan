import { useState } from 'react';
import { logIn, signUp, suggestUsernames } from '../api.js';

const GENDERS = [
  { value: 'woman', label: 'Woman' },
  { value: 'man', label: 'Man' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

export default function Auth({ onSignedIn }) {
  const [mode, setMode] = useState('welcome');

  return (
    <main>
      <header>
        <h1>Darpan</h1>
        <p className="tagline">Your reel coach, right in your pocket.</p>
      </header>
      {mode === 'welcome' && (
        <div className="stack">
          <button className="primary" onClick={() => setMode('signup')}>Create my account</button>
          <button onClick={() => setMode('login')}>I already have an account</button>
        </div>
      )}
      {mode === 'signup' && <SignUp onSignedIn={onSignedIn} onBack={() => setMode('welcome')} />}
      {mode === 'login' && <LogIn onSignedIn={onSignedIn} onBack={() => setMode('welcome')} />}
    </main>
  );
}

function SignUp({ onSignedIn, onBack }) {
  const [step, setStep] = useState('about');
  const [name, setName] = useState('');
  const [gender, setGender] = useState('');
  const [niche, setNiche] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  const onAbout = (e) => {
    e.preventDefault();
    run(async () => {
      await loadSuggestions();
      setStep('username');
    });
  };

  const onUsername = (e) => {
    e.preventDefault();
    setError('');
    setStep('pin');
  };

  const onPin = (e) => {
    e.preventDefault();
    if (pin !== pinConfirm) return setError("The two PINs don't match");
    run(async () => {
      try {
        const { user } = await signUp({ name, gender, niche, username: username.trim(), pin, pinConfirm });
        onSignedIn(user);
      } catch (err) {
        if (err.status !== 409) throw err;
        await loadSuggestions();
        setPin('');
        setPinConfirm('');
        setStep('username');
        throw err;
      }
    });
  };

  return (
    <>
      {step === 'about' && (
        <form className="card" onSubmit={onAbout}>
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
          <fieldset>
            <legend>Gender</legend>
            <div className="chips">
              {GENDERS.map((g) => (
                <label key={g.value} className={`chip ${gender === g.value ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="gender"
                    value={g.value}
                    checked={gender === g.value}
                    onChange={() => setGender(g.value)}
                    required
                  />
                  {g.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            What do you make reels about?
            <textarea
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="e.g. budget street food in Indore, gym for beginners, Marathi comedy"
              maxLength={200}
              rows={2}
              required
            />
          </label>
          <button className="primary" disabled={busy || !name.trim() || !gender || !niche.trim()}>
            {busy ? 'One moment…' : 'Next'}
          </button>
          {error && <p className="error">{error}</p>}
          <button type="button" className="link" onClick={onBack}>Back</button>
        </form>
      )}

      {step === 'username' && (
        <form className="card" onSubmit={onUsername}>
          <p><strong>Pick a username</strong></p>
          <p className="muted">You'll log in with this.</p>
          <div className="chips">
            {suggestions.map((s) => (
              <label key={s} className={`chip ${username === s ? 'selected' : ''}`}>
                <input type="radio" name="username" value={s} checked={username === s} onChange={() => setUsername(s)} />
                {s}
              </label>
            ))}
          </div>
          <label>
            Or type your own
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
          </label>
          <button className="primary" disabled={!username}>Next</button>
          {error && <p className="error">{error}</p>}
          <button type="button" className="link" onClick={() => setStep('about')}>Back</button>
        </form>
      )}

      {step === 'pin' && (
        <form className="card" onSubmit={onPin}>
          <p><strong>Create a 4-digit PIN</strong></p>
          <p className="muted">Logging in as <strong>{username}</strong></p>
          <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
          <label>
            PIN
            <PinInput value={pin} onChange={setPin} autoComplete="new-password" autoFocus />
          </label>
          <label>
            Enter it again
            <PinInput value={pinConfirm} onChange={setPinConfirm} autoComplete="new-password" />
          </label>
          <button className="primary" disabled={busy || pin.length !== 4 || pinConfirm.length !== 4}>
            {busy ? 'Creating your account…' : 'Create account'}
          </button>
          {error && <p className="error">{error}</p>}
          <button type="button" className="link" onClick={() => setStep('username')}>Back</button>
        </form>
      )}
    </>
  );
}

function LogIn({ onSignedIn, onBack }) {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await logIn(username.trim(), pin);
      onSignedIn(user);
    } catch (err) {
      const left = err.body?.attemptsLeft;
      setError(left ? `${err.message}. ${left} ${left === 1 ? 'try' : 'tries'} left.` : err.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={onSubmit}>
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
      <label>
        PIN
        <PinInput value={pin} onChange={setPin} autoComplete="current-password" />
      </label>
      <button className="primary" disabled={busy || !username || pin.length !== 4}>
        {busy ? 'Checking…' : 'Log in'}
      </button>
      {error && <p className="error">{error}</p>}
      <button type="button" className="link" onClick={onBack}>Back</button>
    </form>
  );
}

function PinInput({ value, onChange, ...props }) {
  return (
    <input
      className="pin"
      type="password"
      inputMode="numeric"
      pattern="\d{4}"
      maxLength={4}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
      required
      {...props}
    />
  );
}
