import { useEffect, useState } from 'react';
import { getHealth, getMe, logOut } from './api.js';
import Auth from './screens/Auth.jsx';
import Home from './screens/Home.jsx';
import Camera from './screens/Camera.jsx';

export default function App() {
  const [health, setHealth] = useState(null);
  const [user, setUser] = useState(undefined); // undefined while checking the session
  const [shoot, setShoot] = useState(null); // { idea, format, language } while the camera is open

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
  if (!user) return <Auth onSignedIn={setUser} />;
  if (shoot) return <Camera shoot={shoot} health={health} onClose={() => setShoot(null)} />;
  return <Home user={user} health={health} onShoot={setShoot} onLogOut={onLogOut} />;
}
