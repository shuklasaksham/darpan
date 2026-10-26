import { useEffect, useState } from 'react';
import { Wordmark } from '../ui/Brand.jsx';

async function api(path, options) {
  const res = await fetch(path, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status });
  return json;
}

const rupees = (paise) => `₹${(Number(paise) / 100).toLocaleString('en-IN')}`;
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function Admin() {
  const [data, setData] = useState(undefined); // undefined: checking, null: signed out
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const load = () =>
    api('/api/admin/stats')
      .then(setData)
      .catch((err) => {
        setData(null);
        if (err.status !== 401) setError(err.message);
      });

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

  if (data === undefined) return <main className="center muted">Loading…</main>;

  if (data === null) {
    return (
      <main className="center">
        <Wordmark />
        <h2>Darpan admin</h2>
        <form className="card admin-login" onSubmit={signIn}>
          <label>
            Admin password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          <button className="primary">Sign in</button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  const t = data.totals;
  const max = Math.max(1, ...data.daily.map((d) => Math.max(d.signups, d.takes, d.reels)));

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="brand">
          <Wordmark />
          <span className="muted" style={{ marginLeft: 10 }}>admin</span>
        </div>
        <div className="row">
          <button onClick={load}>Refresh</button>
          <button
            className="link"
            onClick={() => api('/api/admin/logout', { method: 'POST' }).finally(() => setData(null))}
          >
            Sign out
          </button>
        </div>
      </header>

      <section className="stat-grid">
        <Stat label="Creators" value={t.users} sub={`+${t.users_7d} this week · ${t.dev_users ?? 0} dev`} />
        <Stat label="Active this week" value={t.active_7d} sub="recorded a take" />
        <Stat
          label="Pro creators"
          value={t.pro_users}
          sub={`${t.paying_users} paid${t.pro_dev_users ? ` · ${t.pro_dev_users} dev` : ''}`}
          highlight
        />
        <Stat label="Revenue this month" value={rupees(t.revenue_month_paise)} sub={`${rupees(t.revenue_paise)} all time`} highlight />
        <Stat label="Scripts" value={t.scripts} sub={`+${t.scripts_7d} this week`} />
        <Stat label="Takes" value={t.takes} sub={t.avg_score != null ? `avg ${(t.avg_score / 10).toFixed(1)}/10` : ''} />
        <Stat label="Reels made" value={t.reels} sub={t.reels_failed ? `${t.reels_failed} failed` : 'none failed'} />
      </section>

      <section className="card">
        <h3>Last 14 days</h3>
        <div className="bars" role="img" aria-label="Daily signups, takes and reels for the last 14 days">
          {data.daily.map((d) => (
            <div key={d.day} className="bar-day" title={`${d.day}: ${d.signups} signups, ${d.takes} takes, ${d.reels} reels`}>
              <div className="bar-stack">
                <span className="bar signups" style={{ height: `${(d.signups / max) * 100}%` }} />
                <span className="bar takes" style={{ height: `${(d.takes / max) * 100}%` }} />
                <span className="bar reels" style={{ height: `${(d.reels / max) * 100}%` }} />
              </div>
              <small>{d.day.split(' ')[0]}</small>
            </div>
          ))}
        </div>
        <p className="legend">
          <span className="dot signups" /> Signups <span className="dot takes" /> Takes <span className="dot reels" /> Reels
        </p>
      </section>

      <section className="card">
        <h3>Services</h3>
        <div className="chips">
          {Object.entries(data.services)
            .filter(([k]) => k !== 'paymentProvider')
            .map(([name, ok]) => (
              <span key={name} className={`chip ${ok ? 'ok' : 'off'}`}>
                {ok ? '●' : '○'} {name}
                {name === 'payments' && ok ? ` (${data.services.paymentProvider})` : ''}
              </span>
            ))}
        </div>
      </section>

      <Table
        title="Creators"
        cols={['Joined', 'Username', 'Name', 'Niche', 'Plan', 'Takes', 'Reels']}
        rows={data.users.filter((u) => !u.is_dev).map(creatorRow)}
      />
      <Table
        title="Dev accounts"
        cols={['Joined', 'Username', 'Name', 'Niche', 'Plan', 'Takes', 'Reels']}
        rows={data.users.filter((u) => u.is_dev).map(creatorRow)}
      />
      <Table
        title="Reels"
        cols={['When', 'Creator', 'Status', 'Length', 'Size']}
        rows={data.reels.map((r) => [
          when(r.created_at),
          `@${r.username}`,
          r.status === 'error' ? `failed: ${r.error ?? ''}` : r.status,
          r.duration_seconds ? `${Math.round(r.duration_seconds)}s` : '—',
          r.width ? `${r.width}×${r.height}` : '—',
        ])}
      />
      <Table
        title="Takes"
        cols={['When', 'Creator', 'Score', 'Notes by', 'Length']}
        rows={data.takes.map((k) => [
          when(k.created_at),
          `@${k.username}`,
          k.score != null ? `${(k.score / 10).toFixed(1)}/10` : '—',
          k.notes_source ?? '—',
          k.duration_seconds ? `${Math.round(k.duration_seconds)}s` : '—',
        ])}
      />
    </div>
  );
}

const creatorRow = (u) => [
  when(u.created_at),
  `@${u.username}`,
  u.name,
  u.niche,
  u.pro ? (u.pro_complimentary ? 'Pro (free)' : 'Pro') : 'Free',
  u.takes,
  u.reels,
];

function Stat({ label, value, sub, highlight }) {
  return (
    <div className={`stat ${highlight ? 'highlight' : ''}`}>
      <span className="muted">{label}</span>
      <strong>{value ?? 0}</strong>
      {sub && <small className="muted">{sub}</small>}
    </div>
  );
}

function Table({ title, cols, rows }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
