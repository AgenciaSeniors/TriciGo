'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, customerService, incidentService, rideService } from '@tricigo/api';
import type { IncidentReport, Ride } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';

const INCIDENT_TYPE_LABELS: Record<string, string> = {
  sos: 'SOS',
  safety_concern: 'Problema de seguridad',
  payment_dispute: 'Disputa de pago',
  vehicle_issue: 'Problema del vehículo',
  driver_behavior: 'Conducta del conductor',
  passenger_behavior: 'Conducta del pasajero',
};
const INCIDENT_STATUS_LABELS: Record<string, string> = {
  open: 'Abierto',
  investigating: 'En revisión',
  resolved: 'Resuelto',
  dismissed: 'Descartado',
};

export default function SafetyPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [emergencyContact, setEmergencyContact] = useState<any>(null);
  const [activeRide, setActiveRide] = useState<Ride | null>(null);
  const [incidents, setIncidents] = useState<IncidentReport[]>([]);
  const [sharing, setSharing] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!userId) return;
    customerService.getProfile(userId).then((profile) => {
      if (profile?.emergency_contact) {
        setEmergencyContact(profile.emergency_contact);
      }
    }).catch((err) => {
      console.error('Error loading emergency contact:', err);
    });
    // Active ride (drives the "share my trip" card) + my incident history.
    rideService.getActiveRide(userId).then(setActiveRide).catch(() => setActiveRide(null));
    incidentService.getMyIncidents(userId).then(setIncidents).catch(() => setIncidents([]));
  }, [userId]);

  const handleShareTrip = async () => {
    if (!activeRide) return;
    setSharing(true);
    setShareFeedback(null);
    try {
      let token = await rideService.getShareTokenForRide(activeRide.id);
      if (!token) token = await rideService.generateShareToken(activeRide.id);
      const url = `https://tricigo.com/track/share/${token}`;
      const message = t('web.share_trip_message', { url, defaultValue: `Sigue mi viaje de TriciGo en tiempo real: ${url}` });
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'TriciGo', text: message, url });
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setShareFeedback(t('web.share_trip_copied', { defaultValue: 'Enlace copiado al portapapeles' }));
      }
    } catch {
      /* user dismissed the share sheet */
    } finally {
      setSharing(false);
    }
  };

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('common.loading', { defaultValue: 'Cargando...' })}</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)' }}>{t('web.login_required_safety', { defaultValue: 'Inicia sesion para ver la configuracion de seguridad' })}</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          {t('web.login', { defaultValue: 'Iniciar sesion' })}
        </Link>
      </div>
    );
  }

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" aria-label={t('back', { defaultValue: 'Volver' })} style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('web.safety', { defaultValue: 'Seguridad' })}</h1>
      </div>

      {/* SOS Info Section */}
      <div style={{
        background: 'rgba(239,68,68,0.10)',
        borderRadius: '1rem',
        padding: '1.5rem',
        marginBottom: '2rem',
        border: '1px solid rgba(239,68,68,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <div style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: '#e53e3e',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: '#c53030' }}>{t('web.sos_button', { defaultValue: 'Boton SOS' })}</h2>
        </div>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: '0 0 1rem', lineHeight: 1.5 }}>
          {t('web.sos_description', { defaultValue: 'Durante un viaje, puedes presionar el boton SOS para alertar a tus contactos de confianza y compartir tu ubicacion en tiempo real. Tu seguridad es nuestra prioridad.' })}
        </p>
        {/* Llamada directa a emergencias (parity con el botón tel:106 del safety móvil). */}
        <a
          href="tel:106"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0.6rem 1.2rem', borderRadius: '0.6rem', background: '#e53e3e', color: '#fff', fontWeight: 700, fontSize: '0.875rem', textDecoration: 'none' }}
        >
          📞 {t('web.call_emergency', { defaultValue: 'Llamar a emergencias (106)' })}
        </a>
      </div>

      {/* Emergency Contact */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.emergency_contact', { defaultValue: 'Contacto de emergencia' })}
        </h2>
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          padding: '1.25rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: 'var(--border-light)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
                </svg>
              </div>
              <div>
                {emergencyContact ? (
                  <>
                    <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>{emergencyContact.name}</p>
                    <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{emergencyContact.phone}</p>
                  </>
                ) : (
                  <>
                    <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-tertiary)' }}>{t('web.not_configured', { defaultValue: 'No configurado' })}</p>
                    <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>{t('web.add_emergency_hint', { defaultValue: 'Agrega un contacto de emergencia' })}</p>
                  </>
                )}
              </div>
            </div>
            <button
              onClick={() => router.push('/profile/emergency-contact')}
              style={{
                padding: '0.5rem 1rem',
                background: 'var(--primary)',
                color: '#fff',
                border: 'none',
                borderRadius: '0.5rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {emergencyContact ? t('web.edit', { defaultValue: 'Editar' }) : t('web.add', { defaultValue: 'Agregar' })}
            </button>
          </div>
        </div>
      </div>

      {/* Trusted Contacts */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.trusted_contacts', { defaultValue: 'Contactos de confianza' })}
        </h2>
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          padding: '2rem 1.25rem',
          textAlign: 'center',
        }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 00-3-3.87" />
            <path d="M16 3.13a4 4 0 010 7.75" />
          </svg>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-tertiary)', margin: '0.75rem 0 0' }}>
            {t('web.trusted_contacts_hint', { defaultValue: 'Agrega personas de confianza que seran notificadas si activas el boton SOS.' })}
          </p>
          <button
            onClick={() => router.push('/profile/trusted-contacts')}
            style={{
              marginTop: '1rem',
              padding: '0.6rem 1.5rem',
              background: 'transparent',
              color: 'var(--primary)',
              border: '1px solid var(--primary)',
              borderRadius: '0.5rem',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('web.add_contact_button', { defaultValue: 'Agregar contacto' })}
          </button>
        </div>
      </div>

      {/* Share My Trip — active-trip live-share (parity con handleShareTrip móvil) */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.share_trip', { defaultValue: 'Compartir mi viaje' })}
        </h2>
        <div style={{ background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(59,130,246,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </div>
            <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              {t('web.share_trip_desc', { defaultValue: 'Comparte un enlace de seguimiento en vivo con quien quieras durante tu viaje.' })}
            </p>
          </div>
          {activeRide ? (
            <button
              onClick={handleShareTrip}
              disabled={sharing}
              style={{ width: '100%', padding: '0.7rem', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '0.5rem', fontSize: '0.9rem', fontWeight: 600, cursor: sharing ? 'not-allowed' : 'pointer', opacity: sharing ? 0.7 : 1 }}
            >
              {sharing ? t('web.share_trip_sharing', { defaultValue: 'Compartiendo...' }) : t('web.share_now', { defaultValue: 'Compartir ahora' })}
            </button>
          ) : (
            <p style={{ textAlign: 'center', fontSize: '0.82rem', color: 'var(--text-tertiary)', margin: 0 }}>
              {t('web.share_trip_inactive', { defaultValue: 'Disponible cuando tengas un viaje activo.' })}
            </p>
          )}
          {shareFeedback && (
            <p style={{ textAlign: 'center', fontSize: '0.8rem', color: '#16a34a', margin: '0.5rem 0 0' }}>{shareFeedback}</p>
          )}
        </div>
      </div>

      {/* My Safety Reports — incident history (parity con getMyIncidents móvil) */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.my_reports', { defaultValue: 'Mis reportes' })}
        </h2>
        <div style={{ background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '0.5rem 1.25rem' }}>
          {incidents.length === 0 ? (
            <p style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text-tertiary)', padding: '1rem 0', margin: 0 }}>
              {t('web.no_reports', { defaultValue: 'No tienes reportes de seguridad.' })}
            </p>
          ) : (
            incidents.slice(0, 5).map((incident) => (
              <div key={incident.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 0', borderBottom: '1px solid var(--border-light)' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                    {t(`web.incident_type_${incident.type}`, { defaultValue: INCIDENT_TYPE_LABELS[incident.type] ?? incident.type })}
                  </p>
                  <p style={{ margin: '0.15rem 0 0', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                    {new Date(incident.created_at).toLocaleDateString('es-CU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Havana' })}
                  </p>
                </div>
                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: incident.status === 'resolved' ? '#16a34a' : 'var(--text-secondary)' }}>
                  {t(`web.incident_status_${incident.status}`, { defaultValue: INCIDENT_STATUS_LABELS[incident.status] ?? incident.status })}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Safety Tips */}
      <div style={{
        background: 'rgba(34,197,94,0.10)',
        borderRadius: '1rem',
        padding: '1.25rem',
        border: '1px solid rgba(34,197,94,0.3)',
      }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0 0 0.75rem', color: '#166534' }}>
          {t('web.safety_tips', { defaultValue: 'Consejos de seguridad' })}
        </h3>
        <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <li style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{t('web.safety_tip_1', { defaultValue: 'Verifica siempre la placa del vehiculo antes de abordar' })}</li>
          <li style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{t('web.safety_tip_2', { defaultValue: 'Comparte tu viaje en tiempo real con tus contactos' })}</li>
          <li style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{t('web.safety_tip_3', { defaultValue: 'Usa el boton SOS si te sientes en peligro' })}</li>
          <li style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{t('web.safety_tip_4', { defaultValue: 'Califica a tu conductor despues de cada viaje' })}</li>
        </ul>
      </div>
    </main>
  );
}
