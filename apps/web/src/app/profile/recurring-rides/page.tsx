'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, recurringRideService, useFeatureFlag } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { RecurringRide, ServiceTypeSlug, PaymentMethod } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';
import { AddressAutocomplete } from '@/components/AddressAutocomplete';

// Mirrors the mobile CreateRecurringRideSheet: the recurring booking only
// offers the 3 base ride services (no confort/mensajería) and the 2
// payment methods the dispatcher can charge unattended.
const SERVICE_TYPES: { slug: ServiceTypeSlug; icon: string; label: string }[] = [
  { slug: 'triciclo_basico', icon: '🛺', label: 'Triciclo' },
  { slug: 'moto_standard', icon: '🏍️', label: 'Moto' },
  { slug: 'auto_standard', icon: '🚗', label: 'Auto' },
];

const PAYMENT_METHODS: { key: PaymentMethod; icon: string; label: string }[] = [
  { key: 'tricicoin', icon: '👛', label: 'TriciCoin' },
  { key: 'cash', icon: '💵', label: 'Efectivo' },
];

// ISO days: 1=Mon..7=Sun (same convention as recurring_rides.days_of_week).
const DAY_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

function formatNextOccurrence(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('es-CU', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Havana',
  });
}

interface FormState {
  pickupAddress: string;
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffAddress: string;
  dropoffLat: number | null;
  dropoffLng: number | null;
  days: number[];
  time: string; // "HH:MM"
  serviceType: ServiceTypeSlug;
  paymentMethod: PaymentMethod;
}

const EMPTY_FORM: FormState = {
  pickupAddress: '', pickupLat: null, pickupLng: null,
  dropoffAddress: '', dropoffLat: null, dropoffLng: null,
  days: [], time: '08:00',
  serviceType: 'triciclo_basico', paymentMethod: 'tricicoin',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
  fontSize: '0.95rem', background: 'var(--bg-page)', color: 'var(--text-primary)', boxSizing: 'border-box',
};

const fieldLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem',
};

export default function RecurringRidesPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const enabled = useFeatureFlag('recurring_rides_enabled');
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [rides, setRides] = useState<RecurringRide[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Form: null = closed, 'new' = creating, RecurringRide = editing that ride.
  const [formTarget, setFormTarget] = useState<'new' | RecurringRide | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const editing = formTarget !== null && formTarget !== 'new';

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  const loadRides = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await recurringRideService.getRecurringRides(userId);
      setRides(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('web.unknown_error', { defaultValue: 'Error desconocido' }));
    } finally {
      setLoading(false);
    }
  }, [userId, t]);

  useEffect(() => {
    if (userId) loadRides();
  }, [userId, loadRides]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormTarget('new');
  };

  const openEdit = (ride: RecurringRide) => {
    setForm({
      pickupAddress: ride.pickup_address, pickupLat: ride.pickup_latitude, pickupLng: ride.pickup_longitude,
      dropoffAddress: ride.dropoff_address, dropoffLat: ride.dropoff_latitude, dropoffLng: ride.dropoff_longitude,
      days: [...ride.days_of_week].sort(),
      time: ride.time_of_day.slice(0, 5),
      serviceType: ride.service_type, paymentMethod: ride.payment_method,
    });
    setFormTarget(ride);
  };

  const toggleDay = (day: number) => {
    setForm((prev) => ({
      ...prev,
      days: prev.days.includes(day) ? prev.days.filter((d) => d !== day) : [...prev.days, day].sort(),
    }));
  };

  const canSave = editing
    ? form.days.length > 0 && !!form.time
    : form.pickupLat != null && form.dropoffLat != null && form.days.length > 0 && !!form.time;

  const handleSave = async () => {
    if (!userId || !canSave || !formTarget) return;
    setSaving(true);
    try {
      if (formTarget === 'new') {
        await recurringRideService.createRecurringRide({
          user_id: userId,
          pickup_latitude: form.pickupLat as number,
          pickup_longitude: form.pickupLng as number,
          pickup_address: form.pickupAddress,
          dropoff_latitude: form.dropoffLat as number,
          dropoff_longitude: form.dropoffLng as number,
          dropoff_address: form.dropoffAddress,
          service_type: form.serviceType,
          payment_method: form.paymentMethod,
          days_of_week: form.days,
          time_of_day: form.time,
        });
      } else {
        // The service contract only allows updating schedule/service/payment
        // (same as the mobile EditRecurringRideSheet) — addresses are fixed.
        await recurringRideService.updateRecurringRide(formTarget.id, {
          days_of_week: form.days,
          time_of_day: form.time,
          service_type: form.serviceType,
          payment_method: form.paymentMethod,
        });
      }
      setFormTarget(null);
      await loadRides();
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown> | null;
      if (errObj?.code === 'MAX_RECURRING') {
        alert(t('web.recurring_max_reached', { defaultValue: 'Alcanzaste el máximo de viajes recurrentes (10).' }));
      } else {
        alert(t('web.recurring_save_error', { defaultValue: 'No se pudo guardar el viaje recurrente. Intenta de nuevo.' }));
      }
    } finally {
      setSaving(false);
    }
  };

  const handlePauseResume = async (ride: RecurringRide) => {
    setActionLoading(ride.id);
    try {
      if (ride.status === 'active') await recurringRideService.pauseRecurringRide(ride.id);
      else await recurringRideService.resumeRecurringRide(ride.id);
      await loadRides();
    } catch {
      alert(t('web.recurring_action_error', { defaultValue: 'No se pudo completar la acción. Intenta de nuevo.' }));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (ride: RecurringRide) => {
    if (!confirm(t('web.recurring_delete_confirm', { defaultValue: '¿Eliminar este viaje recurrente?' }))) return;
    setActionLoading(ride.id);
    try {
      await recurringRideService.deleteRecurringRide(ride.id);
      await loadRides();
    } catch {
      alert(t('web.recurring_action_error', { defaultValue: 'No se pudo completar la acción. Intenta de nuevo.' }));
    } finally {
      setActionLoading(null);
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
    router.replace('/login');
    return null;
  }

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.75rem' }}>
        <Link href="/profile" aria-label={t('web.back_to_profile', { defaultValue: 'Volver al perfil' })} style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('web.recurring_title', { defaultValue: 'Viajes recurrentes' })}</h1>
      </div>

      <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1.5rem', lineHeight: 1.5 }}>
        {t('web.recurring_desc', { defaultValue: 'Programa tus viajes habituales y pediremos el vehículo por ti los días y a la hora que elijas.' })}
      </p>

      {!enabled ? (
        <WebEmptyState
          icon="⏰"
          title={t('web.recurring_coming_soon', { defaultValue: 'Próximamente' })}
          description={t('web.recurring_coming_soon_desc', { defaultValue: 'Los viajes recurrentes estarán disponibles muy pronto.' })}
        />
      ) : (
        <>
          {error && (
            <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.75rem', padding: '1rem', marginBottom: '1rem' }}>
              <p style={{ color: '#c53030', margin: 0, fontSize: '0.9rem' }}>{error}</p>
              <button onClick={() => { setError(null); setLoading(true); loadRides(); }} style={{ marginTop: '0.5rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem' }}>
                {t('common.retry', { defaultValue: 'Reintentar' })}
              </button>
            </div>
          )}

          {/* List */}
          {loading ? (
            <WebSkeletonList count={3} />
          ) : rides.length === 0 && !formTarget ? (
            <WebEmptyState
              icon="🔁"
              title={t('web.recurring_empty', { defaultValue: 'No tienes viajes recurrentes' })}
              description={t('web.recurring_empty_desc', { defaultValue: 'Crea uno para automatizar tu trayecto al trabajo, la escuela o donde quieras.' })}
              action={{ label: t('web.recurring_create', { defaultValue: 'Crear viaje recurrente' }), onClick: openCreate }}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {rides.map((ride) => (
                <div key={ride.id} style={{
                  background: 'var(--bg-card)', borderRadius: '1rem',
                  border: '1px solid var(--border-light)', padding: '1.25rem',
                }}>
                  {/* Route + status */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ride.pickup_address}
                      </p>
                      <p style={{ margin: '0.2rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        → {ride.dropoff_address}
                      </p>
                    </div>
                    <span style={{
                      flexShrink: 0, fontSize: '0.7rem', fontWeight: 600, padding: '0.2rem 0.6rem', borderRadius: '999px',
                      background: ride.status === 'active' ? 'rgba(34,197,94,0.12)' : 'var(--bg-light)',
                      color: ride.status === 'active' ? '#16a34a' : 'var(--text-tertiary)',
                    }}>
                      {ride.status === 'active'
                        ? t('web.recurring_status_active', { defaultValue: 'Activo' })
                        : t('web.recurring_status_paused', { defaultValue: 'Pausado' })}
                    </span>
                  </div>

                  {/* Days + time */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                    {DAY_LABELS.map((label, i) => {
                      const active = ride.days_of_week.includes(i + 1);
                      return (
                        <span key={i} style={{
                          width: 26, height: 26, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.7rem', fontWeight: 600,
                          background: active ? 'var(--primary)' : 'var(--bg-light)',
                          color: active ? '#fff' : 'var(--text-tertiary)',
                        }}>
                          {label}
                        </span>
                      );
                    })}
                    <span style={{ marginLeft: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      ⏰ {ride.time_of_day.slice(0, 5)}
                    </span>
                  </div>

                  {/* Service + payment + next */}
                  <p style={{ margin: '0.6rem 0 0', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                    {SERVICE_TYPES.find((s) => s.slug === ride.service_type)?.label ?? ride.service_type}
                    {' · '}
                    {PAYMENT_METHODS.find((p) => p.key === ride.payment_method)?.label ?? ride.payment_method}
                    {ride.next_occurrence_at && (
                      <> · {t('web.recurring_next', { defaultValue: 'Próximo:' })} {formatNextOccurrence(ride.next_occurrence_at)}</>
                    )}
                  </p>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.85rem', paddingTop: '0.85rem', borderTop: '1px solid var(--border-light)' }}>
                    <button
                      onClick={() => handlePauseResume(ride)}
                      disabled={actionLoading === ride.id}
                      style={{
                        padding: '0.4rem 0.85rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
                        background: 'transparent', color: 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 600,
                        cursor: actionLoading === ride.id ? 'wait' : 'pointer',
                      }}
                    >
                      {ride.status === 'active'
                        ? t('web.recurring_pause', { defaultValue: '⏸ Pausar' })
                        : t('web.recurring_resume', { defaultValue: '▶ Reanudar' })}
                    </button>
                    <button
                      onClick={() => openEdit(ride)}
                      disabled={actionLoading === ride.id}
                      style={{
                        padding: '0.4rem 0.85rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
                        background: 'transparent', color: 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      {t('web.recurring_edit', { defaultValue: '✎ Editar' })}
                    </button>
                    <button
                      onClick={() => handleDelete(ride)}
                      disabled={actionLoading === ride.id}
                      style={{
                        marginLeft: 'auto', padding: '0.4rem 0.85rem', borderRadius: '0.5rem', border: '1px solid rgba(239,68,68,0.35)',
                        background: 'transparent', color: '#dc2626', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      {t('web.recurring_delete', { defaultValue: 'Eliminar' })}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Create button */}
          {!formTarget && !loading && rides.length > 0 && (
            <button
              onClick={openCreate}
              style={{
                display: 'block', width: '100%', marginTop: '1.5rem', padding: '0.875rem',
                background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)',
                borderRadius: '0.75rem', fontSize: '0.95rem', fontWeight: 600, cursor: 'pointer',
              }}
            >
              {t('web.recurring_create_plus', { defaultValue: '+ Crear viaje recurrente' })}
            </button>
          )}

          {/* Create / Edit form */}
          {formTarget && (
            <div style={{
              marginTop: '1.5rem', background: 'var(--bg-card)', borderRadius: '1rem',
              border: '1px solid var(--border-light)', padding: '1.5rem',
            }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 1rem' }}>
                {editing
                  ? t('web.recurring_edit_title', { defaultValue: 'Editar viaje recurrente' })
                  : t('web.recurring_new_title', { defaultValue: 'Nuevo viaje recurrente' })}
              </h3>

              {/* Route — only editable on create (the service contract, like the
                  mobile sheet, fixes the route once created). */}
              {editing ? (
                <div style={{ marginBottom: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)', background: 'var(--bg-light)', borderRadius: '0.5rem', padding: '0.75rem' }}>
                  <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{form.pickupAddress}</p>
                  <p style={{ margin: '0.25rem 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>→ {form.dropoffAddress}</p>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: '1rem' }}>
                    <label style={fieldLabelStyle}>{t('web.recurring_pickup', { defaultValue: 'Origen' })}</label>
                    <AddressAutocomplete
                      placeholder={t('web.recurring_pickup_ph', { defaultValue: '¿Dónde te recogemos?' })}
                      value={form.pickupAddress}
                      mapboxToken={mapboxToken}
                      onSelect={(r) => setForm((prev) => ({ ...prev, pickupAddress: r.address, pickupLat: r.latitude, pickupLng: r.longitude }))}
                      onClear={() => setForm((prev) => ({ ...prev, pickupAddress: '', pickupLat: null, pickupLng: null }))}
                    />
                  </div>
                  <div style={{ marginBottom: '1rem' }}>
                    <label style={fieldLabelStyle}>{t('web.recurring_dropoff', { defaultValue: 'Destino' })}</label>
                    <AddressAutocomplete
                      placeholder={t('web.recurring_dropoff_ph', { defaultValue: '¿A dónde vas?' })}
                      value={form.dropoffAddress}
                      mapboxToken={mapboxToken}
                      onSelect={(r) => setForm((prev) => ({ ...prev, dropoffAddress: r.address, dropoffLat: r.latitude, dropoffLng: r.longitude }))}
                      onClear={() => setForm((prev) => ({ ...prev, dropoffAddress: '', dropoffLat: null, dropoffLng: null }))}
                    />
                  </div>
                </>
              )}

              {/* Days of week */}
              <div style={{ marginBottom: '1rem' }}>
                <label style={fieldLabelStyle}>{t('web.recurring_days', { defaultValue: 'Días de la semana' })}</label>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  {DAY_LABELS.map((label, i) => {
                    const day = i + 1;
                    const active = form.days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDay(day)}
                        aria-pressed={active}
                        style={{
                          width: 36, height: 36, borderRadius: '50%', border: 'none',
                          fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
                          background: active ? 'var(--primary)' : 'var(--bg-light)',
                          color: active ? '#fff' : 'var(--text-secondary)',
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Time */}
              <div style={{ marginBottom: '1rem' }}>
                <label style={fieldLabelStyle}>{t('web.recurring_time', { defaultValue: 'Hora de salida' })}</label>
                <input
                  type="time"
                  value={form.time}
                  onChange={(e) => setForm((prev) => ({ ...prev, time: e.target.value }))}
                  style={{ ...inputStyle, maxWidth: 160 }}
                />
              </div>

              {/* Service type */}
              <div style={{ marginBottom: '1rem' }}>
                <label style={fieldLabelStyle}>{t('web.recurring_service', { defaultValue: 'Tipo de servicio' })}</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {SERVICE_TYPES.map(({ slug, icon, label }) => {
                    const active = form.serviceType === slug;
                    return (
                      <button
                        key={slug}
                        type="button"
                        onClick={() => setForm((prev) => ({ ...prev, serviceType: slug }))}
                        aria-pressed={active}
                        style={{
                          flex: 1, padding: '0.6rem 0.5rem', borderRadius: '0.75rem', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
                          border: active ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                          background: active ? 'rgba(255,77,0,0.08)' : 'transparent',
                          color: active ? 'var(--primary)' : 'var(--text-secondary)',
                        }}
                      >
                        {icon} {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Payment method */}
              <div style={{ marginBottom: '1.25rem' }}>
                <label style={fieldLabelStyle}>{t('web.recurring_payment', { defaultValue: 'Método de pago' })}</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {PAYMENT_METHODS.map(({ key, icon, label }) => {
                    const active = form.paymentMethod === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setForm((prev) => ({ ...prev, paymentMethod: key }))}
                        aria-pressed={active}
                        style={{
                          flex: 1, padding: '0.6rem 0.5rem', borderRadius: '0.75rem', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
                          border: active ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                          background: active ? 'rgba(255,77,0,0.08)' : 'transparent',
                          color: active ? 'var(--primary)' : 'var(--text-secondary)',
                        }}
                      >
                        {icon} {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button
                  onClick={() => setFormTarget(null)}
                  disabled={saving}
                  style={{
                    flex: 1, padding: '0.75rem', background: 'transparent', color: 'var(--text-secondary)',
                    border: '1px solid var(--border)', borderRadius: '0.5rem', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  {t('common.cancel', { defaultValue: 'Cancelar' })}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !canSave}
                  style={{
                    flex: 1, padding: '0.75rem', background: 'var(--primary)', color: '#fff',
                    border: 'none', borderRadius: '0.5rem', fontSize: '0.9rem', fontWeight: 600,
                    cursor: saving ? 'not-allowed' : 'pointer', opacity: saving || !canSave ? 0.6 : 1,
                  }}
                >
                  {saving
                    ? t('web.recurring_saving', { defaultValue: 'Guardando...' })
                    : t('web.recurring_save', { defaultValue: 'Guardar' })}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}
