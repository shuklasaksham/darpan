import { useEffect, useState } from 'react';
import { getHealth, getMe, logOut } from './api.js';
import Auth from './screens/Auth.jsx';
import Home from './screens/Home.jsx';
import Camera from './screens/Camera.jsx';
import Script from './screens/Script.jsx';
import Landing from './screens/Landing.jsx';
import Admin from './screens/Admin.jsx';
import Legal, { LEGAL_PATHS } from './screens/Legal.jsx';
import { activePlanId, rememberActive, resumeState } from './screens/Recent.jsx';
import { getRecent } from './api.js';

const IS_ADMIN = window.location.pathname.startsWith('/admin');

export default function App() {
  if (LEGAL_PATHS.includes(window.location.pathname)) return <Legal page={window.location.pathname.slice(1)} />;
  return IS_ADMIN ? <Admin /> : <CreatorApp />;
}

function CreatorApp() {
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
  const [health, setHealth] = useState(null);
  const [user, setUser] = useState(undefined); // undefined while checking the session
  const [shoot, setShoot] = useState(null); // { idea, format, language }
  const [planned, setPlanned] = useState(null); // finalised script; opens the camera
  const [initialKept, setInitialKept] = useState(null);
  const [authMode, setAuthMode] = useState(null); // null shows the marketing page

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ ok: false }));
    getMe()
      .then(async ({ user }) => {
        // Reloaded mid-shoot? Go straight back to it, takes and all.
        const active = user && activePlanId();
        if (active) {
          const item = (await getRecent().catch(() => ({ shoots: [] }))).shoots.find((s) => s.planId === active);
          if (item) resume(resumeState(item));
          else rememberActive(null);
        }
        setUser(user);
      })
      .catch(() => setUser(null));
  }, []);

  async function onLogOut() {
    await logOut().catch(() => {});
    setShoot(null);
    setUser(null);
  }

  if (user === undefined) return <main className="center muted">Loading…</main>;
  if (!user && !authMode) return <Landing onSignUp={() => setAuthMode('signup')} onLogIn={() => setAuthMode('login')} />;
  if (!user) return <Auth initialMode={authMode} onSignedIn={setUser} onExit={() => setAuthMode(null)} />;
  const close = () => {
    rememberActive(null);
    setInitialKept(null);
    setPlanned(null);
    setShoot(null);
  };
  if (shoot && planned) return <Camera shoot={shoot} planned={planned} initialKept={initialKept} health={health} onClose={close} />;
  if (shoot) return <Script shoot={shoot} health={health} onStart={startCamera} onBack={close} />;
  return <Home user={user} health={health} onShoot={setShoot} onResume={resume} onLogOut={onLogOut} />;
}
