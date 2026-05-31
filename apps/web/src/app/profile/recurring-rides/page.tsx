'use client';

/**
 * Recurring rides (web) — parity con apps/client/app/profile/recurring-rides.
 * List + create + delete recurring schedules via recurringRideService. Create
 * reuses the web AddressAutocomplete for pickup/dropoff selection.
 */
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { recurringRideService } from '@tricigo/api';
import type { RecurringRide, ServiceTypeSlug, PaymentMethod } from '@tricigo/types';
import { enrichWithCrossStreets } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useAuth } from '../../providers';
import { AddressAutocomplete } from '@/components/AddressAutocomplete';

const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const SERVICE_OPTIONS: { slug: ServiceTypeSlug; label: string }[] = [
  { slug: 'triciclo_basico', label: 'Triciclo' },
  { slug: 'moto_standard', label: 'Moto' },
  { slug: 'auto_standard', label: 'Auto' },
  { slug: 'auto_confort', label: 'Confort' },
];

type LatLng = { label: string; address: string; latitude: number; longitude: number };

export default function RecurringRidesPage() {
  const router = useRouter();
  const { t } = useTranslation('common');
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

  const [rides, setRides] = useState<RecurringRide[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [showForm, setShowForm] = useState(false);
  const [pickup, setPickup] = useState<LatLng | null>(null);
  const [dropoff, setDropoff] = useState<LatLng | null>(null);
  const [days, setDays] = useState<number[]>([]);
  const [time, setTime] = useState('08:00');
  const [serviceType, setServiceType] = useState<ServiceTypeSlug>('triciclo_basico');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.replace('/login');
  }, [authLoading, isAuthenticated, router]);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      setRides(await recurringRideService.getRecurringRides(user.id));
    } catch {
      setError(t('errors.generic', { defaultValue: 'No se pudieron cargar los viajes recurrentes.' }));
    } finally {
      setLoading(false);
    }
  }, [user?.id, t]);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setShowForm(false);
    setPickup(null);
    setDropoff(null);
    setDays([]);
    setTime('08:00');
    setServiceType('triciclo_basico');
    setPaymentMethod('cash');
  }

  async function handleCreate() {
    if (!user?.id || !pickup || !dropoff || days.length === 0) {
      setError(t('recurring.incomplete', { defaultValue: 'Completa origen, destino y al menos un día.' }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await recurringRideService.createRecurringRide({
        user_id: user.id,
        pickup_latitude: pickup.latitude,
        pickup_longitude: pickup.longitude,
        pickup_address: pickup.address || pickup.label,
        dropoff_latitude: dropoff.latitude,
        dropoff_longitude: dropoff.longitude,
        dropoff_address: dropoff.address || dropoff.label,
        service_type: serviceType,
        payment_method: paymentMethod,
        days_of_week: [...days].sort(),
        time_of_day: time,
      });
      resetForm();
      await load();
    } catch (err) {
      const msg = (err as { code?: string })?.code === 'MAX_RECURRING'
        ? t('recurring.max_reached', { defaultValue: 'Alcanzaste el máximo de viajes recurrentes (10).' })
        : t('errors.generic', { defaultValue: 'No se pudo crear el viaje recurrente.' });
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t('recurring.delete_confirm', { defaultValue: '¿Eliminar este viaje recurrente?' }))) return;
    setRides((prev) => prev.filter((r) => r.id !== id));
    try { await recurringRideService.deleteRecurringRide(id); } catch { await load(); }
  }

  const toggleDay = (d: number) => setDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);
  const card: React.CSSProperties = { padding: '1rem', borderRadius: '0.85rem', border: '1px solid var(--border)', background: 'var(--bg-card)' };

  return (
    <main className="page-main">
      <div className="page-container" style={{ maxWidth: 560 }}>
        <Link href="/profile" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>&larr; {t('back', { defaultValue: 'Volver' })}</Link>
        <h1 style={{ fontSize: 'clamp(1.4rem,4vw,1.9rem)', fontWeight: 800, margin: '1rem 0 0.25rem' }}>
          {t('recurring.title', { defaultValue: 'Viajes recurrentes' })}
        </h1>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
          {t('recurring.subtitle', { defaultValue: 'Programá viajes que se repiten en los días y horario que elijas.' })}
        </p>

        {error && <p style={{ color: 'var(--error, #dc2626)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>{error}</p>}

        {/* Existing list */}
        {loading ? (
          <p style={{ color: 'var(--text-tertiary)' }}>{t('loading', { defaultValue: 'Cargando…' })}</p>
        ) : rides.length === 0 ? (
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            {t('recurring.empty', { defaultValue: 'Aún no tenés viajes recurrentes.' })}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
            {rides.map((r) => (
              <div key={r.id} style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>
                      {(r.days_of_week ?? []).map((d) => DAY_LABELS[d]).join(' · ')} · {r.time_of_day?.slice(0, 5)}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 4 }}>{r.pickup_address}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>→ {r.dropoff_address}</div>
                  </div>
                  <button type="button" onClick={() => handleDelete(r.id)} aria-label="Eliminar"
                    style={{ background: 'none', border: 'none', color: 'var(--error, #dc2626)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, flexShrink: 0 }}>
                    {t('delete', { defaultValue: 'Eliminar' })}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Create */}
        {!showForm ? (
          <button type="button" onClick={() => setShowForm(true)}
            style={{ width: '100%', padding: '0.85rem', borderRadius: '0.75rem', border: '1px dashed var(--border)', background: 'var(--bg-card)', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)' }}>
            + {t('recurring.add', { defaultValue: 'Agregar viaje recurrente' })}
          </button>
        ) : (
          <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <AddressAutocomplete
              label={t('book.map_pickup_label', { defaultValue: 'Origen' })}
              placeholder="¿Dónde te recogemos?"
              value={pickup?.address || ''}
              mapboxToken={mapboxToken}
              enrichAddress={enrichWithCrossStreets}
              onSelect={(r) => setPickup({ label: r.place_name, address: r.address, latitude: r.latitude, longitude: r.longitude })}
              onClear={() => setPickup(null)}
            />
            <AddressAutocomplete
              label={t('book.map_dropoff_label', { defaultValue: 'Destino' })}
              placeholder="¿A dónde vas?"
              value={dropoff?.address || ''}
              mapboxToken={mapboxToken}
              enrichAddress={enrichWithCrossStreets}
              onSelect={(r) => setDropoff({ label: r.place_name, address: r.address, latitude: r.latitude, longitude: r.longitude })}
              onClear={() => setDropoff(null)}
            />

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('recurring.days', { defaultValue: 'Días' })}</label>
              <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                {DAY_LABELS.map((label, d) => {
                  const on = days.includes(d);
                  return (
                    <button key={d} type="button" onClick={() => toggleDay(d)}
                      style={{ width: 42, padding: '0.45rem 0', borderRadius: '0.5rem', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
                        border: on ? '2px solid var(--primary)' : '1px solid var(--border)',
                        background: on ? 'rgba(255,77,0,0.08)' : 'var(--bg-page)',
                        color: on ? 'var(--primary)' : 'var(--text-secondary)' }}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 120 }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('recurring.time', { defaultValue: 'Hora' })}</label>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="input-base" style={{ width: '100%', marginTop: '0.35rem' }} />
              </div>
              <div style={{ flex: 1, minWidth: 120 }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('recurring.service', { defaultValue: 'Servicio' })}</label>
                <select value={serviceType} onChange={(e) => setServiceType(e.target.value as ServiceTypeSlug)} className="input-base" style={{ width: '100%', marginTop: '0.35rem' }}>
                  {SERVICE_OPTIONS.map((s) => <option key={s.slug} value={s.slug}>{s.label}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('book.payment_method', { defaultValue: 'Método de pago' })}</label>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.35rem' }}>
                {(['cash', 'tricicoin'] as PaymentMethod[]).map((pm) => (
                  <button key={pm} type="button" onClick={() => setPaymentMethod(pm)}
                    style={{ flex: 1, padding: '0.5rem', borderRadius: '0.5rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
                      border: paymentMethod === pm ? '2px solid var(--primary)' : '1px solid var(--border)',
                      background: paymentMethod === pm ? 'rgba(255,77,0,0.08)' : 'var(--bg-page)',
                      color: paymentMethod === pm ? 'var(--primary)' : 'var(--text-secondary)' }}>
                    {pm === 'cash' ? t('book.payment_cash', { defaultValue: 'Efectivo' }) : 'TriciCoin'}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" onClick={resetForm} style={{ flex: 1, padding: '0.7rem', borderRadius: '0.6rem', border: '1px solid var(--border)', background: 'var(--bg-page)', cursor: 'pointer', fontSize: '0.85rem' }}>
                {t('cancel', { defaultValue: 'Cancelar' })}
              </button>
              <button type="button" onClick={handleCreate} disabled={saving || !pickup || !dropoff || days.length === 0}
                style={{ flex: 1, padding: '0.7rem', borderRadius: '0.6rem', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', fontSize: '0.85rem', fontWeight: 700, color: '#fff',
                  background: (!pickup || !dropoff || days.length === 0 || saving) ? '#ccc' : 'var(--primary)' }}>
                {saving ? t('saving', { defaultValue: 'Guardando…' }) : t('save', { defaultValue: 'Guardar' })}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
