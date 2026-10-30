import { Wordmark } from '../ui/Brand.jsx';
import Glyph from '../ui/Glyph.jsx';

// Marketing page for visitors who aren't logged in.
export function LegalFooter() {
  return (
    <footer className="landing-footer">
      <span>© {new Date().getFullYear()} Darpan</span>
      <span>
        <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/refunds">Refunds</a> · <a href="/contact">Contact</a>
      </span>
    </footer>
  );
}

const FREE = ['3 reels a month', 'Scripts for your niche and trends', 'Live camera coach', "Director's notes on every take", 'Your camera’s full quality, up to 4K, with a small “Shot with darpan” tag'];
const PRO = ['Unlimited reels for 30 days', 'Everything in Free', 'No tag on your reels', 'Priority rendering'];

const HOW = [
  ['Say your idea', "Type it or say it in Hinglish. Darpan writes a short script for your niche and what's trending."],
  ['Shoot with a coach', 'A teleprompter that follows your voice, a frame guide, and spoken tips on light and framing.'],
  ['Post your reel', 'Trimmed to your words, captioned in Hinglish, Hindi or English, and ready for Instagram, Shorts or WhatsApp.'],
];

export default function Landing({ onSignUp, onLogIn }) {
  return (
    <div className="landing">
      <nav className="landing-nav">
        <a href="/" aria-label="Darpan home">
          <Wordmark />
        </a>
        <button className="link strong" onClick={onLogIn}>Log in</button>
      </nav>

      <section className="hero">
        <h1>
          Shoot your <span className="last">first reel.</span>
        </h1>
        <div className="hero-photo">
          <img src="/img/hero-kitchen.jpg" alt="A creator filming herself in her kitchen with Darpan's frame guide" width="768" height="1376" fetchPriority="high" />
          <span className="guide" aria-hidden="true" />
          <span className="pill" aria-hidden="true">
            <Glyph name="check" size={18} /> Perfect. Hold it there
          </span>
        </div>
        <div className="stack loose">
          <p className="lede">Darpan writes your script, coaches you in Hinglish while you shoot, and hands back a finished, captioned reel.</p>
          <div className="hero-cta">
            <button className="primary block" onClick={onSignUp}>Start free</button>
            <p className="tiny muted center-text">3 reels a month free · Pro ₹299 for 30 days</p>
          </div>
        </div>
      </section>

      <section className="landing-section">
        <h2>Three steps. One reel.</h2>
        <ol className="how">
          {HOW.map(([title, body], i) => (
            <li key={title}>
              <span className="num">{i + 1}</span>
              <strong>{title}</strong>
              <span>{body}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section">
        <h2>Pricing</h2>
        <div className="plans">
          <div className="plan">
            <h3>Free</h3>
            <p className="price">₹0</p>
            <ul>
              {FREE.map((f) => (
                <li key={f}>
                  <Glyph name="check" size={20} /> {f}
                </li>
              ))}
            </ul>
            <button onClick={onSignUp}>Start free</button>
          </div>
          <div className="plan pro">
            <span className="tag" style={{ alignSelf: 'flex-start' }}>
              <Glyph name="pro" size={14} /> Pro
            </span>
            <p className="price">
              ₹299<span>for 30 days</span>
            </p>
            <ul>
              {PRO.map((f) => (
                <li key={f}>
                  <Glyph name="check" size={20} /> {f}
                </li>
              ))}
            </ul>
            <button className="primary" onClick={() => onSignUp('pro')}>Go Pro</button>
          </div>
        </div>
        <p className="tiny muted center-text">Secure payments by Razorpay: UPI, cards and netbanking. No auto-renewal.</p>
      </section>

      <LegalFooter />
    </div>
  );
}
