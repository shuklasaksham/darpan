import { useState } from 'react';
import Glyph from './Glyph.jsx';
import { framingFor } from '../camera/framing.js';

export function BackBar({ onBack, title, strong = false, right = null, label = 'Back' }) {
  return (
    <header className="topbar">
      <button className="icon-btn bare" onClick={onBack} aria-label={label}>
        <Glyph name="back" />
      </button>
      <span className={`title ${strong ? 'strong' : ''}`}>{title}</span>
      {right}
    </header>
  );
}

const TABS = [
  { id: 'home', label: 'Home', glyph: 'home' },
  { id: 'recent', label: 'Recent', glyph: 'recent' },
  { id: 'account', label: 'Account', glyph: 'account' },
];

export function TabBar({ tab, onTab }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => onTab(t.id)}>
          <Glyph name={t.glyph} />
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export function Switch({ checked, onChange, children }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}

/** A take's thumbnail from the server, with a quiet placeholder until (or unless) it loads. */
export function Poster({ src, className = '', children, alt = '' }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`poster ${className}`}>
      {src && !failed ? <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} /> : <Glyph name="take" />}
      {children}
    </div>
  );
}

/** The framing a shot needs, drawn as a phone with the face box where it should sit. */
export function FramingTile({ framing }) {
  const { headTop, scale } = framingFor(framing);
  const H = 108;
  const W = 60;
  const box = Math.min(34, Math.max(10, 0.13 * scale * 1.35 * 64));
  const cy = 18 + (headTop + 0.065 * scale) * 72;
  return (
    <div className="framing-tile" aria-label={framingFor(framing).label}>
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <rect x="14" y="18" width="32" height="72" rx="6" fill="none" stroke="var(--marigold-500)" strokeWidth="2" />
        <circle cx="30" cy={Math.min(80, cy)} r={box / 3.2} fill="var(--ink-300)" />
      </svg>
    </div>
  );
}

const firstOfNextMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
};
export const resetDate = (opts = { day: 'numeric', month: 'long' }) => firstOfNextMonth().toLocaleDateString('en-IN', opts);
export const shortDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });

export const formatTime = (total) => {
  const s = Math.max(0, Math.round(total));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Instagram's, Facebook's and similar in-app browsers block the camera and mic. */
export function inAppBrowser() {
  const ua = navigator.userAgent || '';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'Facebook';
  if (/Snapchat/i.test(ua)) return 'Snapchat';
  if (/LinkedInApp/i.test(ua)) return 'LinkedIn';
  return null;
}

export function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(`darpan.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    localStorage.setItem(`darpan.${key}`, JSON.stringify(value));
  } catch {}
}
