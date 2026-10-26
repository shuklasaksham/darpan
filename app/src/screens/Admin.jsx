import { useEffect, useState } from 'react';
import { Wordmark } from '../ui/Brand.jsx';
import Glyph from '../ui/Glyph.jsx';

async function api(path, options) {
  const res = await fetch(path, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status });
  return json;
}

const rupees = (paise) => `₹${(Number(paise) / 100).toLocaleString('en-IN')}`;
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

const VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'creators', label: 'Creators' },
  { id: 'reels', label: 'Reels' },
  { id: 'takes', label: 'Takes' },
  { id: 'payments', label: 'Payments' },
];

const SERVICES = {
  database: ['Database', 'Postgres'],
  claude: ['Claude', 'Scripts, notes, captions'],
  deepgram: ['Deepgram', 'Speech-to-text'],
  sarvam: ['Sarvam', 'Hindi voice'],
  payments: ['Payments', null],
};

/** Owner dashboard (Figma D04): a sidebar of views, with the overview first. */
export default function Admin() {
  const [data, setData] = useState(undefined); // undefined: checking, null: signed out
  const [updatedAt, setUpdatedAt] = useState(null);
  const [view, setView] = useState('overview');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    setBusy(true);
    return api('/api/admin/stats')
      .then((d) => {
        setData(d);
        setUpdatedAt(new Date());
      })
      .catch((err) => {
        setData(null);
        if (err.status !== 401) setError(err.message);
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load();
  }, []);

  async function signIn(e) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      setPassword('');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (data === undefined) {
    return (
      <main className="admin-login-screen">
        <div className="loader" aria-label="Loading" />
      </main>
    );
  }

  if (data === null) {
    return (
      <main className="admin-login-screen">
        <form className="admin-login" onSubmit={signIn} noValidate>
          <div className="stack tight">
            <Wordmark />
            <span className="small muted">Admin</span>
          </div>
          <h1>Sign in</h1>
          <label>
            Admin password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary block" disabled={!password}>
            Sign in
          </button>
        </form>
      </main>
    );
  }

  const paid = data.payments.filter((p) => p.status === 'paid');
  const creators = data.users.filter((u) => !u.is_dev);
  const devs = data.users.filter((u) => u.is_dev);
  const title = VIEWS.find((v) => v.id === view).label;

  return (
    <div className="admin-shell">
      <aside className="admin-side">
        <div className="admin-brand">
          <Wordmark />
          <span className="small muted">Admin</span>
        </div>
        <nav aria-label="Admin">
          {VIEWS.map((v) => (
            <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </nav>
        <button className="link admin-signout" onClick={() => api('/api/admin/logout', { method: 'POST' }).finally(() => setData(null))}>
          Sign out
        </button>
      </aside>

      <main className="admin-main">
        <header className="admin-head">
          <div className="stack tight">
            <h1>{title}</h1>
            <p className="small muted">Updated {when(updatedAt)}</p>
          </div>
          <button className="secondary" onClick={load} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'} <Glyph name="reshoot" size={20} />
          </button>
        </header>

        {view === 'overview' && <Overview data={data} paid={paid} onView={setView} />}
        {view === 'creators' && (
          <div className="admin-stack">
            <Table title={`Creators · ${creators.length}`} cols={CREATOR_COLS} rows={creators.map(creatorRow)} />
            <Table title={`Dev accounts · ${devs.length}`} cols={CREATOR_COLS} rows={devs.map(creatorRow)} />
          </div>
        )}
        {view === 'reels' && (
          <Table
            title="Latest reels"
            cols={['When', 'Creator', 'Status', 'Length', 'Size']}
            rows={data.reels.map((r) => [
              when(r.created_at),
              `@${r.username}`,
              <span key="s" className="row" style={{ gap: 8 }}>
                <Badge ok={r.status === 'done'} label={r.status === 'error' ? 'Failed' : r.status === 'done' ? 'Done' : r.status} />
                {r.status === 'error' && r.error && <small className="muted">{r.error}</small>}
              </span>,
              r.duration_seconds ? `${Math.round(r.duration_seconds)}s` : '—',
              r.width ? `${r.width}×${r.height}` : '—',
            ])}
          />
        )}
        {view === 'takes' && (
          <Table
            title="Latest takes"
            cols={['When', 'Creator', 'Score', 'Notes by', 'Length']}
            rows={data.takes.map((k) => [
              when(k.created_at),
              `@${k.username}`,
              k.score != null ? `${(k.score / 10).toFixed(1)}/10` : '—',
              k.notes_source === 'claude' ? 'Claude' : k.notes_source === 'rules' ? 'Rules' : '—',
              k.duration_seconds ? `${Math.round(k.duration_seconds)}s` : '—',
            ])}
          />
        )}
        {view === 'payments' && (
          <Table
            title={`Successful payments · ${paid.length}`}
            cols={['When', 'Creator', 'Amount']}
            rows={paid.map((p) => [when(p.created_at), `@${p.username}`, rupees(p.amount_paise)])}
          />
        )}
      </main>
    </div>
  );
}

function Overview({ data, paid, onView }) {
  const t = data.totals;
  const services = Object.keys(SERVICES).filter((k) => k in data.services);
  return (
    <div className="admin-overview">
      <div className="admin-stack">
        <section className="stat-group four">
          <Stat label="Creators" value={t.users} sub={`+${t.users_7d} this week · ${t.dev_users ?? 0} dev`} />
          <Stat label="Active this week" value={t.active_7d} sub="recorded a take" />
          <Stat label="Pro creators" value={t.pro_users} sub={`${t.paying_users} paid${t.pro_dev_users ? ` · ${t.pro_dev_users} dev` : ''}`} />
          <Stat label="Revenue this month" value={rupees(t.revenue_month_paise)} sub={`${rupees(t.revenue_paise)} all time`} />
        </section>
        <section className="stat-group three">
          <Stat label="Scripts" value={t.scripts} sub={`+${t.scripts_7d} this week`} />
          <Stat label="Takes" value={t.takes} sub={t.avg_score != null ? `avg ${(t.avg_score / 10).toFixed(1)}/10` : 'no scores yet'} />
          <Stat label="Reels made" value={t.reels} sub={t.reels_failed ? `${t.reels_failed} failed` : 'none failed'} />
        </section>
        <DailyChart daily={data.daily} />
      </div>

      <div className="admin-stack">
        <section className="stack">
          <h2>Services</h2>
          <ul className="admin-list">
            {services.map((key) => {
              const [name, about] = SERVICES[key];
              const ok = data.services[key];
              const provider = data.services.paymentProvider;
              return (
                <li key={key}>
                  <span className="grow">
                    <strong>{name}</strong>
                    <small>{about ?? (ok && provider !== 'none' ? providerName(provider) : 'Not set up')}</small>
                  </span>
                  <Badge ok={ok} label={ok ? 'Connected' : 'Off'} />
                </li>
              );
            })}
          </ul>
        </section>
        <section className="stack">
          <h2>Latest payments</h2>
          {paid.length === 0 ? (
            <p className="muted small">No payments yet.</p>
          ) : (
            <>
              <ul className="admin-list">
                {paid.slice(0, 3).map((p, i) => (
                  <li key={i}>
                    <span className="grow">
                      <strong>@{p.username}</strong>
                      <small>{when(p.created_at)}</small>
                    </span>
                    <strong>{rupees(p.amount_paise)}</strong>
                  </li>
                ))}
              </ul>
              {paid.length > 3 && (
                <button className="secondary" style={{ alignSelf: 'flex-start', minHeight: 44 }} onClick={() => onView('payments')}>
                  View all {paid.length}
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

const providerName = (p) => ({ razorpay_page: 'Razorpay page', razorpay: 'Razorpay', pinelabs: 'Pine Labs' })[p] ?? p;

const SERIES = [
  { key: 'takes', label: 'Takes', className: 'takes' },
  { key: 'signups', label: 'Sign-ups', className: 'signups' },
  { key: 'reels', label: 'Reels', className: 'reels' },
];

/** A round axis top: 1, 2 or 5 times a power of ten, at or above the largest value. */
function niceMax(n) {
  if (n <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= n);
}

/** What the last 14 days say, in one line: the busiest day if it stands out, else the totals. */
function headline(daily) {
  const total = daily.reduce((n, d) => n + d.signups, 0);
  const top = daily.reduce((a, d) => (d.signups > a.signups ? d : a), daily[0]);
  if (total >= 5 && top.signups / total >= 0.4) return `${top.signups} of ${total} sign-ups came on ${top.day}`;
  const takes = daily.reduce((n, d) => n + d.takes, 0);
  return `${total} sign-ups and ${takes} takes in the last 14 days`;
}

function DailyChart({ daily }) {
  const [hover, setHover] = useState(null);
  const max = niceMax(Math.max(1, ...daily.flatMap((d) => [d.signups, d.takes, d.reels])));
  const ticks = [0, max / 2, max];
  const peak = daily.reduce((a, d, i) => (d.takes + d.signups > daily[a].takes + daily[a].signups ? i : a), 0);

  return (
    <section className="admin-card">
      <h2>{headline(daily)}</h2>
      <p className="chart-legend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <i className={s.className} /> {s.label}
          </span>
        ))}
      </p>
      <div className="chart" role="img" aria-label={`Daily takes, sign-ups and reels for the last 14 days. ${headline(daily)}.`}>
        <div className="chart-grid" aria-hidden="true">
          {ticks
            .slice()
            .reverse()
            .map((v) => (
              <span key={v} style={{ bottom: `${(v / max) * 100}%` }}>
                <b>{v}</b>
              </span>
            ))}
        </div>
        <div className="chart-days">
          {daily.map((d, i) => (
            <div
              key={d.day}
              className={`chart-day ${hover === i ? 'on' : ''}`}
              tabIndex={0}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${d.day}: ${d.takes} takes, ${d.signups} sign-ups, ${d.reels} reels`}
            >
              <div className="chart-bars">
                {SERIES.map((s) => (
                  <span key={s.key} className={`bar ${s.className}`} style={{ height: `${(d[s.key] / max) * 100}%` }}>
                    {i === peak && d[s.key] > 0 && <em>{d[s.key]}</em>}
                  </span>
                ))}
              </div>
              <small className={i === peak ? 'peak' : ''}>{d.day.split(' ')[0]}</small>
              {hover === i && (
                <div className="chart-tip" role="tooltip">
                  <strong>{d.day}</strong>
                  {SERIES.map((s) => (
                    <span key={s.key}>
                      <i className={s.className} /> {s.label} <b>{d[s.key]}</b>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const CREATOR_COLS = ['Joined', 'Username', 'Name', 'Niche', 'Plan', 'Takes', 'Reels'];
const creatorRow = (u) => [
  when(u.created_at),
  `@${u.username}`,
  u.name,
  u.niche,
  u.pro ? <Badge key="p" ok label={u.pro_complimentary ? 'Pro (free)' : 'Pro'} brand /> : 'Free',
  u.takes,
  u.reels,
];

function Badge({ ok, label, brand = false }) {
  return (
    <span className={`badge ${brand ? 'brand' : ok ? 'ok' : 'off'}`}>
      {label}
    </span>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <span className="small muted">{label}</span>
      <strong>{value ?? 0}</strong>
      {sub && <small className="muted">{sub}</small>}
    </div>
  );
}

function Table({ title, cols, rows }) {
  return (
    <section className="admin-card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
