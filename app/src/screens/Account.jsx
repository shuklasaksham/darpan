import { useState } from 'react';
import Glyph from '../ui/Glyph.jsx';
import { Switch, readPref, resetDate, shortDate, writePref } from '../ui/parts.jsx';
import { LANGUAGE_OPTIONS, savedLanguage, saveLanguage } from './Home.jsx';
import Picker from '../ui/Picker.jsx';
import { Paywall, useBilling } from './Plan.jsx';
import { shootProgress } from './Recent.jsx';
import { posterUrl, updateNiche } from '../api.js';
import { NicheFields } from './Auth.jsx';

export default function Account({ user, shoots, onLogOut, onUserChange }) {
  const [billing] = useBilling();
  const [language, setLanguage] = useState(savedLanguage);
  const [voiceTips, setVoiceTips] = useState(() => readPref('voiceTips', true));
  const [paywall, setPaywall] = useState(false);
  const [editingNiche, setEditingNiche] = useState(false);
  const niche = user.niche?.split(':')[0];
  const pro = billing?.plan === 'pro';
  const used = billing?.reelsThisMonth ?? 0;
  const allowed = billing?.reelsPerMonth ?? 3;
  const posterTake = (shoots ?? []).map((s) => shootProgress(s).posterTakeId).find(Boolean);

  return (
    <main className="screen with-tabs">
      <div className="profile" style={{ paddingTop: 'var(--space-4)' }}>
        <span className="avatar big" aria-hidden="true">
          {user.name[0]?.toUpperCase()}
        </span>
        <div className="stack tight grow">
          <h1>{user.name}</h1>
          <p className="muted">
            @{user.username}
            {niche ? ` · ${niche}` : ''}
          </p>
        </div>
      </div>

      {billing && (
        <section className="stack">
          <div className="row between" style={{ alignItems: 'baseline' }}>
            <span className="plan-big">{pro ? 'Pro' : 'Free'}</span>
            {!pro && (
              <span>
                {Math.min(used, allowed)} of {allowed} reels
              </span>
            )}
          </div>
          {pro ? (
            <p className="muted">Unlimited reels in 1080p with no tag, until {shortDate(billing.proUntil)}. No auto-renewal.</p>
          ) : (
            <>
              <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={allowed} aria-valuenow={used}>
                <i style={{ width: `${Math.min(100, (used / allowed) * 100)}%` }} />
              </div>
              <p className="muted small">Resets on {resetDate()}. Pro: unlimited reels, 1080p, no tag.</p>
              <button className="brand block" onClick={() => setPaywall(true)}>
                Go Pro · ₹{billing.priceRupees} for 30 days
              </button>
            </>
          )}
        </section>
      )}

      <ul className="list">
        <li>
          <button className="list-row" onClick={() => setEditingNiche(true)}>
            Your niche
            <span className="value" style={{ minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{niche || 'Not set'}</span>
              <Glyph name="chevron" size={18} />
            </span>
          </button>
        </li>
        <li>
          <div className="list-row" style={{ cursor: 'default' }}>
            Script language
            <Picker
              variant="value"
              label="Script language"
              value={language}
              options={LANGUAGE_OPTIONS}
              onChange={(v) => {
                setLanguage(v);
                saveLanguage(v);
              }}
            />
          </div>
        </li>
        <li>
          <div className="list-row">
            <Switch
              checked={voiceTips}
              onChange={(v) => {
                setVoiceTips(v);
                writePref('voiceTips', v);
              }}
            >
              Spoken tips
            </Switch>
          </div>
        </li>
        <li>
          <a className="list-row" href="/terms">
            Terms and privacy <Glyph name="chevron" size={18} />
          </a>
        </li>
        <li>
          <a className="list-row" href="/refunds">
            Refunds <Glyph name="chevron" size={18} />
          </a>
        </li>
        <li>
          <a className="list-row" href="/contact">
            Contact us <Glyph name="chevron" size={18} />
          </a>
        </li>
      </ul>
      <button className="link" style={{ alignSelf: 'flex-start' }} onClick={onLogOut}>
        Log out
      </button>

      {editingNiche && (
        <NicheSheet
          current={user.niche}
          onClose={() => setEditingNiche(false)}
          onSaved={(u) => {
            onUserChange(u);
            setEditingNiche(false);
          }}
        />
      )}
      {paywall && <Paywall billing={billing} posterSrc={posterTake ? posterUrl(posterTake) : null} onClose={() => setPaywall(false)} />}
    </main>
  );
}

function NicheSheet({ current, onSaved, onClose }) {
  const [niche, setNiche] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const full = niche.trim();

  async function save(e) {
    e.preventDefault();
    if (full === current) return onClose();
    setBusy(true);
    setError('');
    try {
      const { user } = await updateNiche(full);
      onSaved(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Change your niche" onClick={onClose}>
      <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Your niche</h2>
        <p className="muted">Scripts and trending ideas follow this.</p>
        <NicheFields value={niche} onChange={setNiche} />
        {error && <p className="error">{error}</p>}
        <button className="primary block" disabled={busy || !full}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="link" onClick={onClose}>
          Cancel
        </button>
      </form>
    </div>
  );
}
