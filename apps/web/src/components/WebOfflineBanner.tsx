/**
 * WebOfflineBanner — global "no connection" indicator for the web app.
 *
 * Parity with the mobile OfflineBanner (apps/client + apps/driver mount one
 * app-wide). The web had none: only the in-ride chat was connectivity-aware, so
 * on Cuban 3G a disconnect gave the rider no proactive feedback on the main
 * flows (Home, /book). This is feedback only (navigator.onLine + online/offline
 * events) — NOT an offline mutation queue (that stays mobile-only, deferred).
 */
'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';

export function WebOfflineBanner() {
  const { t } = useTranslation('web');
  // Start optimistic so SSR + first client render agree (null), then the effect
  // reconciles with the real navigator.onLine.
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        padding: '8px 16px',
        backgroundColor: '#b91c1c',
        color: '#ffffff',
        textAlign: 'center',
        zIndex: 10000,
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      {t('offline', { defaultValue: 'Sin conexión — revisa tu red.' })}
    </div>
  );
}
