import { useEffect, useState } from 'react';
import { getHealth, getMe, logOut } from './api.js';
import Auth from './screens/Auth.jsx';
import Home from './screens/Home.jsx';
import Camera from './screens/Camera.jsx';
import Script from './screens/Script.jsx';
import Landing from './screens/Landing.jsx';

export default function App() {
  const [health, setHealth] = useState(null);
  const [user, setUser] = useState(undefined); // undefined while checking the session
  const [shoot, setShoot] = useState(null); // { idea, format, language }
  const [planned, setPlanned] = useState(null); // finalised script; opens the camera
  const [authMode, setAuthMode] = useState(null); // null shows the marketing page

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ ok: false }));
    getMe()
      .then(({ user }) => setUser(user))
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
    setPlanned(null);
    setShoot(null);
  };
  if (shoot && planned) return <Camera shoot={shoot} planned={planned} health={health} onClose={close} />;
  if (shoot) return <Script shoot={shoot} health={health} onStart={setPlanned} onBack={close} />;
  return <Home user={user} health={health} onShoot={setShoot} onLogOut={onLogOut} />;
}
