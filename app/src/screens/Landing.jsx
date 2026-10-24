// Marketing page for visitors who aren't logged in.
const FREE = ['3 reels a month', 'Scripts for your niche and trends', 'Live camera coach', "Director's notes on every take", '720p export with the Darpan tag'];
const PRO = ['Unlimited reels', 'Everything in Free', 'Full HD 1080p export', 'No Darpan tag', 'Priority reel rendering'];

export default function Landing({ onSignUp, onLogIn }) {
  return (
    <div className="landing">
      <nav className="landing-nav">
        <a href="/" className="brand">
          <img src="/logo.svg" alt="" width="22" height="33" />
          <span>Darpan</span>
        </a>
        <button className="link" onClick={onLogIn}>Log in</button>
      </nav>

      <section className="hero">
        <p className="tag">Made for first-time Indian creators</p>
        <h1>Shoot reels like a pro, from your phone.</h1>
        <p className="lede">
          Darpan writes your script, coaches you live while you shoot and hands you a finished reel with Hinglish
          captions.
        </p>
        <button className="primary big" onClick={onSignUp}>Start free</button>
        <p className="muted small">No card needed. Works on Android and iPhone.</p>
      </section>

      <section className="landing-section">
        <h2>How it works</h2>
        <ol className="how">
          <li>
            <strong>Tell Darpan your idea</strong>
            <span>Type it or say it in Hinglish. Darpan writes a script for your niche and what's trending.</span>
          </li>
          <li>
            <strong>Shoot with a coach</strong>
            <span>A teleprompter, a pose guide, and spoken tips on light, framing and your voice.</span>
          </li>
          <li>
            <strong>Get your reel</strong>
            <span>Trimmed, captioned and ready to post. Download or share straight to Instagram.</span>
          </li>
        </ol>
      </section>

      <section className="landing-section">
        <h2>Pricing</h2>
        <div className="plans">
          <div className="plan">
            <h3>Free</h3>
            <p className="price">₹0</p>
            <ul>{FREE.map((f) => <li key={f}>{f}</li>)}</ul>
            <button onClick={onSignUp}>Start free</button>
          </div>
          <div className="plan pro">
            <p className="tag">Most popular</p>
            <h3>Pro</h3>
            <p className="price">
              ₹299<span>/month</span>
            </p>
            <ul>{PRO.map((f) => <li key={f}>{f}</li>)}</ul>
            <button className="primary" onClick={() => onSignUp('pro')}>Go Pro</button>
          </div>
        </div>
        <p className="muted small center-text">Secure payments by Pine Labs. UPI, cards and netbanking. Cancel anytime.</p>
      </section>

      <footer className="landing-footer">
        <span>© {new Date().getFullYear()} Darpan</span>
        <a href="mailto:hello@darpan.app">Contact</a>
      </footer>
    </div>
  );
}
