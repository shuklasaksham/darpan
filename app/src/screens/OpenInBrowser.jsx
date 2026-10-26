import { useState } from 'react';
import { Wordmark } from '../ui/Brand.jsx';
import Glyph from '../ui/Glyph.jsx';

/** Shown inside Instagram's (and similar) in-app browsers, which can't open the camera and mic. */
export default function OpenInBrowser({ app, onContinue }) {
  const [copied, setCopied] = useState(false);
  const iPhone = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const browser = iPhone ? 'Safari' : 'Chrome';

  return (
    <main className="screen with-bar">
      <header className="topbar">
        <Wordmark />
      </header>
      <div className="stack loose" style={{ paddingTop: 'var(--space-8)' }}>
        <h1 className="display" style={{ fontSize: 48 }}>Open Darpan in {browser}</h1>
        <p className="muted" style={{ fontSize: 18 }}>
          {app}’s built-in browser can’t use your camera and mic properly. It takes two taps to switch.
        </p>
        <ol className="steps">
          <li>
            <span>
              Tap <strong>⋯</strong> at the top right of this screen
            </span>
          </li>
          <li>
            <span>
              Choose <strong>“Open in {browser}”</strong>
              {!iPhone && <span className="muted"> (on iPhone, “Open in Safari”)</span>}
            </span>
          </li>
        </ol>
        <p className="notice">
          <Glyph name="check" size={20} />
          Your account and takes are kept. You’ll pick up right where you left off.
        </p>
      </div>
      <div className="action-bar">
        <button className="secondary" onClick={onContinue}>
          I’m in {browser}
        </button>
        <button
          className="primary"
          onClick={() => {
            navigator.clipboard
              ?.writeText(window.location.href)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          <Glyph name="link" size={20} />
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      </div>
    </main>
  );
}
