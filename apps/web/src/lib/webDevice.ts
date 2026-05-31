import { deviceService } from '@tricigo/api';

const DEVICE_ID_KEY = 'tricigo_device_id';

/** Stable per-browser install id (persisted in localStorage). */
function getWebDeviceId(): string {
  if (typeof window === 'undefined') return 'web-ssr';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { localStorage.setItem(DEVICE_ID_KEY, id); } catch { /* private mode */ }
  }
  return id;
}

/**
 * Register this browser against the logged-in user for new-device login
 * detection (parity con deviceService.registerLoginDevice móvil). Fire-and-
 * forget — a failure must never block login, so callers don't await.
 */
export function registerWebLoginDevice(): void {
  try {
    deviceService.registerLoginDevice({
      device_id: getWebDeviceId(),
      platform: 'web',
      model: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : null,
      os_version: typeof navigator !== 'undefined' ? (navigator.platform || null) : null,
      app_version: process.env.NEXT_PUBLIC_APP_VERSION ?? 'web',
    }).catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
}
