import { useEffect, useState } from 'react';
import { getBilling, startCheckout } from '../api.js';

/** Sends the creator to Pine Labs' checkout for Pro. */
export async function goPro(setError) {
  try {
    const { redirectUrl } = await startCheckout();
    window.location.assign(redirectUrl);
  } catch (err) {
    setError?.(err.message);
  }
}

/** Plan status on the home screen: reels left on Free, or Pro's renewal date. */
export function PlanCard() {
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice] = useState(() => new URLSearchParams(window.location.search).get('billing'));

  useEffect(() => {
    getBilling().then(setBilling).catch(() => {});
    // Drop ?billing=... from the address bar once read.
    if (notice) window.history.replaceState(null, '', '/');
  }, [notice]);

  if (!billing) return null;
  const left = billing.reelsPerMonth == null ? null : Math.max(0, billing.reelsPerMonth - billing.reelsThisMonth);

  return (
    <section className={`plan-card ${billing.plan}`}>
      {notice === 'success' && <p className="good-note">Payment received. Welcome to Pro!</p>}
      {notice === 'pending' && <p className="muted">We're confirming your payment. Pro switches on in a few minutes.</p>}
      {notice === 'failed' && <p className="error">The payment didn't go through. You haven't been charged.</p>}
      {billing.plan === 'pro' ? (
        <p>
          <span className="tag">PRO</span> Unlimited reels until{' '}
          {new Date(billing.proUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
        </p>
      ) : (
        <div className="row between">
          <p>
            <strong>Free</strong> · {left} of {billing.reelsPerMonth} reels left this month
          </p>
          {billing.paymentsEnabled && (
            <button
              className="primary small-button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                goPro(setError).finally(() => setBusy(false));
              }}
            >
              Go Pro ₹{billing.priceRupees}
            </button>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
