import { useEffect, useState } from 'react';
import { getBilling, startCheckout, verifyRazorpay } from '../api.js';
import { Wordmark } from '../ui/Brand.jsx';
import Glyph from '../ui/Glyph.jsx';
import { Poster, resetDate, shortDate } from '../ui/parts.jsx';

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error("Couldn't load the payment window. Check your connection."));
    document.head.appendChild(script);
  });
}

/**
 * Starts paying for Pro: Razorpay's checkout popup, the Razorpay Payment Page,
 * or a redirect to Pine Labs' hosted checkout, depending on how the server is set up.
 */
export async function goPro(setError) {
  try {
    const order = await startCheckout();
    if (order.provider === 'razorpay_page') {
      window.open(order.url, '_blank', 'noopener');
      return;
    }
    if (order.provider !== 'razorpay') {
      window.location.assign(order.redirectUrl);
      return;
    }
    await loadRazorpay();
    await new Promise((resolve) => {
      const checkout = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: 'Darpan',
        description: 'Darpan Pro, 30 days',
        image: `${window.location.origin}/icons/icon-192.png`,
        prefill: { name: order.name },
        theme: { color: '#f0a23b' },
        handler: async (response) => {
          try {
            const { status } = await verifyRazorpay(response);
            window.location.assign(`/?billing=${status}`);
          } catch (err) {
            setError?.(err.message);
          }
          resolve();
        },
        modal: { ondismiss: resolve },
      });
      checkout.on('payment.failed', () => setError?.("The payment didn't go through. You haven't been charged."));
      checkout.open();
    });
  } catch (err) {
    setError?.(err.message);
  }
}

export function useBilling() {
  const [billing, setBilling] = useState(null);
  const reload = () => getBilling().then(setBilling).catch(() => {});
  useEffect(() => {
    reload();
  }, []);
  return [billing, reload];
}

/**
 * Pro, sold on what the creator gets: their own frame as Free (with our tag)
 * next to Pro (clean), then the price.
 */
export function Paywall({ billing, reason = 'upgrade', posterSrc = null, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const until = new Date(Date.now() + 30 * 864e5);
  const price = billing?.priceRupees ?? 299;
  const limit = reason === 'limit';

  return (
    <div className="paywall studio" role="dialog" aria-modal="true" aria-label="Darpan Pro">
      <div className="screen" style={{ gap: 'var(--space-5)' }}>
        <header className="topbar">
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Glyph name="x" />
          </button>
        </header>
        <div className="compare">
          <figure className="free">
            <Poster src={posterSrc}>
              <span className="tagmark">
                Shot with <Wordmark className="inline-mark" />
              </span>
            </Poster>
            <figcaption>Free · with our tag</figcaption>
          </figure>
          <figure className="pro">
            <Poster src={posterSrc} />
            <figcaption>Pro · no tag</figcaption>
          </figure>
        </div>
        <div className="stack">
          <h1>{limit ? `Your ${billing?.reelsPerMonth ?? 3} free reels are used up` : 'Make every reel look pro'}</h1>
          <p className="muted" style={{ fontSize: 17 }}>
            {limit ? 'Go Pro to make this reel now, and every reel after it for 30 days.' : 'Unlimited reels for 30 days, without our tag.'}
          </p>
        </div>
        <ul className="checks">
          <li>
            <Glyph name="check" size={20} /> Unlimited reels until {shortDate(until)}
          </li>
          <li>
            <Glyph name="check" size={20} /> No “Shot with darpan” tag on your reels
          </li>
          <li>
            <Glyph name="check" size={20} /> Same scripts, live coaching and notes
          </li>
        </ul>
        <p className="row" style={{ alignItems: 'baseline' }}>
          <span className="price-big">₹{price}</span>
          <span className="muted small">once · about ₹{Math.round(price / 30)} a day</span>
        </p>
        {billing?.provider === 'razorpay_page' && <PagePaymentSteps username={billing.username} />}
        {billing?.paymentsEnabled === false ? (
          <button className="brand block" disabled>
            Pro is coming soon
          </button>
        ) : (
          <button
            className="brand block"
            disabled={busy || !billing}
            onClick={() => {
              setBusy(true);
              setError('');
              goPro(setError).finally(() => setBusy(false));
            }}
          >
            {busy ? 'Opening payment…' : `Pay ₹${price} with UPI or card`}
          </button>
        )}
        {error && <p className="error">{error}</p>}
        <p className="tiny muted center-text">Razorpay secure · No auto-renew · Refund in 48 h if unused</p>
        {billing?.provider === 'razorpay_page' && (
          <button onClick={() => window.location.assign('/?billing=pending')}>I’ve paid, check now</button>
        )}
        {limit ? (
          <button className="link strong" onClick={onClose}>
            Wait for {billing?.reelsPerMonth ?? 3} free reels on {resetDate({ day: 'numeric', month: 'short' })}
          </button>
        ) : (
          <button className="link" onClick={onClose}>
            Not now
          </button>
        )}
      </div>
    </div>
  );
}

/** The Payment Page can't know who's paying, so the creator types their username there. */
function PagePaymentSteps({ username }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice" style={{ flexDirection: 'column' }}>
      <span>
        On the payment page, type your username in the <strong>Darpan username</strong> box:
      </span>
      <button
        className="block"
        onClick={() => {
          navigator.clipboard?.writeText(username).then(() => setCopied(true)).catch(() => {});
        }}
      >
        {username} · {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** After paying: confirming, failed, or Pro is on. */
export function BillingNotice({ status, onDone }) {
  const [billing, reload] = useBilling();
  const [checking, setChecking] = useState(false);
  const isPro = billing?.plan === 'pro';
  const [error, setError] = useState('');

  // A pending payment usually settles within a minute; keep checking quietly.
  useEffect(() => {
    if (status !== 'pending' || isPro) return;
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [status, isPro]);

  if (isPro || status === 'success') {
    return (
      <main className="screen with-bar">
        <div className="big-state">
          <span className="tag" style={{ alignSelf: 'flex-start' }}>
            <Glyph name="pro" size={14} /> Pro
          </span>
          <h1 className="display" style={{ fontSize: 56 }}>You’re on Pro</h1>
          <p className="muted" style={{ fontSize: 18 }}>
            Unlimited reels with no tag{billing?.proUntil ? `, until ${shortDate(billing.proUntil)}` : ''}. It doesn’t renew by itself.
          </p>
        </div>
        <div className="action-bar">
          <button className="primary" onClick={onDone}>
            Make my reel now
          </button>
        </div>
      </main>
    );
  }

  if (status === 'failed') {
    return (
      <main className="screen with-bar">
        <div className="big-state">
          <h1>Payment didn’t go through</h1>
          <p className="muted" style={{ fontSize: 18 }}>
            No money was taken. If your bank shows a charge, it’s reversed automatically within 5–7 working days.
          </p>
          <a className="small" href="/contact">Contact support</a>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="action-bar">
          <button className="secondary" onClick={onDone}>
            Not now
          </button>
          <button className="primary" onClick={() => goPro(setError)}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="screen with-bar">
      <div className="big-state">
        <div className="loader" />
        <h1>Confirming your payment</h1>
        <p className="muted" style={{ fontSize: 18 }}>Paid by UPI? Approve the request in your UPI app. This usually takes under a minute.</p>
        <p className="small muted">Taking longer than 2 minutes? We keep checking with Razorpay, and Pro switches on by itself once it clears.</p>
      </div>
      <div className="action-bar">
        <button className="secondary" onClick={onDone}>
          Later
        </button>
        <button
          className="primary"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            reload().finally(() => setChecking(false));
          }}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </main>
  );
}
