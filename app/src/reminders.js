// The daily reel-idea notification: turning it on and off on this phone.
import { getPushKey, subscribePush, unsubscribePush } from './api.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** iPhones only allow notifications for web apps added to the Home Screen. */
export const needsHomeScreen = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && !(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone);

const registration = () => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);

/** Whether this phone already gets the daily reminder. */
export async function remindersOn() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return Boolean(await reg?.pushManager.getSubscription());
}

const keyBytes = (base64) => {
  const raw = atob((base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/**
 * Asks for permission and subscribes this phone. Returns 'on', 'denied' (the
 * creator said no or blocked it) or 'unsupported'.
 */
export async function turnOnReminders(language) {
  if (!pushSupported() || needsHomeScreen()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await registration();
  const { publicKey } = await getPushKey();
  const subscription = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await subscribePush(subscription.toJSON(), language);
  return 'on';
}

export async function turnOffReminders() {
  const reg = await navigator.serviceWorker?.getRegistration('/');
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return;
  await unsubscribePush(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe();
}
