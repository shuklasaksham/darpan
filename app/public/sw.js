// Darpan's service worker: only shows the daily reel-idea notification and
// opens the app when it's tapped. It caches nothing, so updates are never stuck.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Today’s reel idea', {
      body: data.body || 'Your idea for today is ready.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'daily-idea',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
