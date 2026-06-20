'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { deviceService, authService, type KnownDevice } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { getWebDeviceId } from '@/lib/webDevice';

function formatLastSeen(iso: string): string {
  try {
    return new Intl.DateTimeFormat('es-CU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Havana',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function DevicesPage() {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<KnownDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    setCurrentDeviceId(getWebDeviceId());
  }, []);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await deviceService.listMyDevices();
      setDevices(rows);
      setError(false);
    } catch (err) {
      console.error('Error loading devices:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  async function handleRevoke(device: KnownDevice) {
    if (!confirm(t('web.revoke_device_confirm', { defaultValue: 'Quitar este dispositivo? Tendras que volver a confirmarlo la proxima vez que inicies sesion desde el.' }))) return;
    try {
      await deviceService.revokeDevice(device.id);
      await loadDevices();
    } catch (err) {
      console.error('Error revoking device:', err);
      alert(t('web.revoke_device_error', { defaultValue: 'Error al quitar el dispositivo. Intenta de nuevo.' }));
    }
  }

  async function handleSignOutAll() {
    if (!confirm(t('web.sign_out_all_confirm', { defaultValue: 'Cerrar sesion en todos los dispositivos? Tendras que iniciar sesion de nuevo en cada uno.' }))) return;
    setLoggingOut(true);
    try {
      await authService.signOut();
    } catch (err) {
      console.error('Error signing out everywhere:', err);
    } finally {
      window.location.href = '/';
    }
  }

  const DeleteIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  );

  const DeviceIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  );

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1.5rem' }}>
        <Link href="/profile" aria-label={t('back', { defaultValue: 'Volver' })} style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('web.devices_title', { defaultValue: 'Tus dispositivos' })}</h1>
      </div>

      <p style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', margin: '0 0 1.5rem' }}>
        {t('web.devices_subtitle', { defaultValue: 'Dispositivos desde los que has iniciado sesion en tu cuenta.' })}
      </p>

      {loading ? (
        <p style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: '2rem 0' }}>
          {t('web.loading_devices', { defaultValue: 'Cargando dispositivos...' })}
        </p>
      ) : error ? (
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          padding: '2rem 1.25rem',
          textAlign: 'center',
          marginBottom: '1.5rem',
        }}>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-tertiary)', margin: '0 0 1rem' }}>
            {t('web.devices_load_error', { defaultValue: 'No se pudieron cargar los dispositivos.' })}
          </p>
          <button
            onClick={loadDevices}
            style={{
              padding: '0.65rem 1.25rem', background: 'transparent', color: 'var(--primary)',
              border: '1px solid var(--primary)', borderRadius: '0.5rem', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
            }}
          >
            {t('common.retry', { defaultValue: 'Reintentar' })}
          </button>
        </div>
      ) : devices.length === 0 ? (
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          padding: '2rem 1.25rem',
          textAlign: 'center',
          marginBottom: '1.5rem',
        }}>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-tertiary)', margin: 0 }}>
            {t('web.no_devices', { defaultValue: 'No hay dispositivos registrados todavia.' })}
          </p>
        </div>
      ) : (
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          overflow: 'hidden',
          marginBottom: '1.5rem',
        }}>
          {devices.map((device, index) => {
            const title = [device.model, device.platform].filter(Boolean).join(' · ')
              || t('web.unknown_device', { defaultValue: 'Dispositivo desconocido' });
            const isCurrent = currentDeviceId != null && device.device_id === currentDeviceId;
            return (
              <div
                key={device.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '1rem 1.25rem',
                  borderBottom: index < devices.length - 1 ? '1px solid var(--border-light)' : 'none',
                }}
              >
                <div style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  background: 'var(--bg-page)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: '1rem',
                  color: 'var(--primary)',
                  flexShrink: 0,
                }}>
                  <DeviceIcon />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{title}</p>
                    {isCurrent && (
                      <span style={{
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        color: 'var(--primary)',
                        background: 'rgba(255,77,0,0.1)',
                        borderRadius: '0.4rem',
                        padding: '0.1rem 0.45rem',
                        flexShrink: 0,
                      }}>
                        {t('web.this_device', { defaultValue: 'Este dispositivo' })}
                      </span>
                    )}
                  </div>
                  {device.os_version && (
                    <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>{device.os_version}</p>
                  )}
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                    {t('web.last_seen', { defaultValue: 'Visto por ultima vez {{date}}', date: formatLastSeen(device.last_seen_at) })}
                  </p>
                </div>
                <button
                  onClick={() => handleRevoke(device)}
                  aria-label={t('web.revoke_device', { defaultValue: 'Quitar' })}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem', flexShrink: 0 }}
                >
                  <DeleteIcon />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Sign out everywhere */}
      <button
        onClick={handleSignOutAll}
        disabled={loggingOut}
        style={{
          display: 'block', width: '100%', padding: '0.875rem',
          background: 'transparent', color: '#e53e3e', border: '1px solid #e53e3e',
          borderRadius: '0.75rem', fontSize: '0.95rem', fontWeight: 600,
          cursor: loggingOut ? 'not-allowed' : 'pointer',
          opacity: loggingOut ? 0.6 : 1,
        }}
      >
        {loggingOut
          ? t('web.signing_out_all', { defaultValue: 'Cerrando sesion...' })
          : t('web.sign_out_all', { defaultValue: 'Cerrar sesion en todos los dispositivos' })}
      </button>
    </main>
  );
}
