import { lazy, Suspense, useEffect, useState } from 'react';
import { getHealth, getMe, getRecent, logOut } from './api.js';
import Auth from './screens/Auth.jsx';
import Home from './screens/Home.jsx';
import Script from './screens/Script.jsx';
import Landing from './screens/Landing.jsx';
import { RecentReels, activePlanId, rememberActive, resumeState } from './screens/Recent.jsx';
import Account from './screens/Account.jsx';
import { BillingNotice } from './screens/Plan.jsx';
import OpenInBrowser from './screens/OpenInBrowser.jsx';
import { TabBar, inAppBrowser } from './ui/parts.jsx';
// Loaded only when needed, so the first screen downloads less.
const Camera = lazy(() => import('./screens/Camera.jsx'));
const Admin = lazy(() => import('./screens/Admin.jsx'));
const Legal = lazy(() => import('./screens/Legal.jsx'));
const LEGAL_PATHS = ['/terms', '/privacy', '/refunds', '/contact'];
const loading = (
  <main className="screen center">
    <div className="loader" aria-label="Loading" />
  </main>
);

const IS_ADMIN = window.location.pathname.startsWith('/admin');

export default function App() {
  if (LEGAL_PATHS.includes(window.location.pathname)) {
    return (
      <Suspense fallback={loading}>
        <Legal page={window.location.pathname.slice(1)} />
      </Suspense>
    );
  }
  if (IS_ADMIN) {
    return (
      <Suspense fallback={loading}>
        <Admin />
      </Suspense>
    );
  }
  return <CreatorApp />;
}

function CreatorApp() {
  const [health, setHealth] = useState(null);
  const [user, setUser] = useState(undefined); // undefined while checking the session
  const [shoot, setShoot] = useState(null); // { idea, format, language }
  const [planned, setPlanned] = useState(null); // finalised script; opens the camera
  const [initialKept, setInitialKept] = useState(null);
  const [authMode, setAuthMode] = useState(null); // null shows the marketing page
  const [tab, setTab] = useState('home');
  const [shoots, setShoots] = useState(null); // recent shoots, shared by Home and Recent
  const [inApp, setInApp] = useState(() => {
    try {
      return sessionStorage.getItem('darpan.inAppOk') ? null : inAppBrowser();
    } catch {
      return inAppBrowser();
    }
  });
  const [billingNotice, setBillingNotice] = useState(() => new URLSearchParams(window.location.search).get('billing'));

  function resume({ shoot, planned, kept }) {
    setShoot(shoot);
    setInitialKept(kept);
    setPlanned(planned);
    rememberActive(planned.planId);
  }
  function startCamera(p) {
    setPlanned(p);
    rememberActive(p.planId);
  }
  const loadShoots = () =>
    getRecent()
      .then(({ shoots }) => {
        setShoots(shoots);
        return shoots;
      })
      .catch(() => {
        setShoots([]);
        return [];
      });

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ ok: false }));
    getMe()
      .then(async ({ user }) => {
        if (user) {
          // Reloaded mid-shoot? Go straight back to it, takes and all.
          const list = await loadShoots();
          const active = activePlanId();
          const item = active && !billingNotice && list.find((s) => s.planId === active);
          if (item) resume(resumeState(item));
          else if (active) rememberActive(null);
        }
        setUser(user);
      })
      .catch(() => setUser(null));
    if (billingNotice) window.history.replaceState(null, '', '/');
  }, []);

  async function onLogOut() {
    await logOut().catch(() => {});
    setShoot(null);
    setShoots(null);
    setTab('home');
    setUser(null);
  }

  if (inApp) {
    return (
      <OpenInBrowser
        app={inApp}
        onContinue={() => {
          try {
            sessionStorage.setItem('darpan.inAppOk', '1');
          } catch {}
          setInApp(null);
        }}
      />
    );
  }
  if (user === undefined) return loading;
  if (!user && !authMode) return <Landing onSignUp={() => setAuthMode('signup')} onLogIn={() => setAuthMode('login')} />;
  if (!user) {
    return (
      <Auth
        initialMode={authMode}
        onSignedIn={(u) => {
          setUser(u);
          loadShoots();
        }}
        onExit={() => setAuthMode(null)}
      />
    );
  }
  if (billingNotice) {
    return <BillingNotice status={billingNotice} onDone={() => setBillingNotice(null)} />;
  }
  const close = () => {
    rememberActive(null);
    setInitialKept(null);
    setPlanned(null);
    setShoot(null);
    loadShoots();
  };
  if (shoot && planned) {
    return (
      <Suspense fallback={loading}>
        <Camera shoot={shoot} planned={planned} initialKept={initialKept} health={health} onClose={close} />
      </Suspense>
    );
  }
  if (shoot) return <Script shoot={shoot} user={user} health={health} onStart={startCamera} onBack={close} />;

  return (
    <>
      {tab === 'home' && (
        <Home user={user} health={health} shoots={shoots} onShoot={setShoot} onResume={resume} onAccount={() => setTab('account')} />
      )}
      {tab === 'recent' && <RecentReels shoots={shoots} onResume={resume} onStart={() => setTab('home')} />}
      {tab === 'account' && <Account user={user} shoots={shoots} onLogOut={onLogOut} />}
      <TabBar tab={tab} onTab={setTab} />
    </>
  );
}
