import { useEffect, useState } from 'react';
import { getBilling, startCheckout, verifyRazorpay } from '../api.js';

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
 * Starts paying for Pro: Razorpay's checkout popup, or a redirect to Pine Labs'
 * hosted checkout, depending on which the server is set up with.
 */
export async function goPro(setError) {
  try {
    const order = await startCheckout();
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
        theme: { color: '#f5a21b' },
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

/** Plan status on the home screen: reels left on Free, or Pro's renewal date. */
export function PlanCard() {
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
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
          <button className="primary small-button" onClick={() => setUpgradeOpen(true)}>
            Upgrade
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {upgradeOpen && (
        <UpgradeSheet
          billing={billing}
          busy={busy}
          error={error}
          onPay={() => {
            setBusy(true);
            setError('');
            goPro(setError).finally(() => setBusy(false));
          }}
          onClose={() => setUpgradeOpen(false)}
        />
      )}
    </section>
  );
}

const PRO_PERKS = ['Unlimited reels every month', 'Full HD 1080p export', 'No "Shot with Darpan" tag', 'Priority reel rendering'];

function UpgradeSheet({ billing, busy, error, onPay, onClose }) {
  return (
    <div className="upgrade-backdrop" role="dialog" aria-modal="true" aria-label="Upgrade to Pro" onClick={onClose}>
      <div className="upgrade-sheet" onClick={(e) => e.stopPropagation()}>
        <span className="tag">PRO</span>
        <h2>
          ₹{billing.priceRupees}
          <small> for 30 days</small>
        </h2>
        <ul>
          {PRO_PERKS.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        {billing.paymentsEnabled ? (
          <button className="primary" disabled={busy} onClick={onPay}>
            {busy ? 'Opening payment…' : `Pay ₹${billing.priceRupees}`}
          </button>
        ) : (
          <button className="primary" disabled>
            Pro is coming soon
          </button>
        )}
        <p className="muted small">Secure payment by {billing.provider === 'pinelabs' ? 'Pine Labs' : 'Razorpay'}: UPI, cards and netbanking. No auto-renewal.</p>
        {error && <p className="error">{error}</p>}
        <button className="link" onClick={onClose}>
          Not now
        </button>
      </div>
    </div>
  );
}
