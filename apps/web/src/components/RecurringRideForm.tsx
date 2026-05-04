'use client';

/**
 * RecurringRideForm — campos compartidos entre create + edit recurring rides.
 *
 * Espejo de los dos sheets nativos:
 *   - apps/client/src/components/CreateRecurringRideSheet.tsx
 *   - apps/client/src/components/EditRecurringRideSheet.tsx
 *
 * Decisiones de paridad:
 *   - **Service types**: 3 opciones (triciclo_basico / moto_standard /
 *     auto_standard) — mismo subset que mobile usa en estos sheets,
 *     aunque el booking flow soporta más (auto_confort, mensajeria).
 *     Razón: viajes recurrentes son típicamente commute, no delivery.
 *   - **Payment methods**: tricicoin + cash — mismo subset que mobile.
 *   - **Days**: array de 1..7 (Mon=1, Sun=7), guardado como int[].
 *   - **Time**: "HH:MM" 24h. Web usa <input type="time"> nativo.
 *
 * Edit mode pasa `mode='edit'` + ride iniciales — el form pre-popula
 * todo y bloquea pickup/dropoff (mobile EditSheet también los muestra
 * read-only porque cambiar la ruta cambia la naturaleza del recurring
 * ride; mejor borrarlo y crear uno nuevo).
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import type { RecurringRide, ServiceTypeSlug, PaymentMethod } from '@tricigo/types';
import { AddressAutocomplete } from '@/components/AddressAutocomplete';

const DAY_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

const SERVICE_TYPES: { slug: ServiceTypeSlug; label: string }[] = [
  { slug: 'triciclo_basico', label: 'Triciclo' },
  { slug: 'moto_standard', label: 'Moto' },
  { slug: 'auto_standard', label: 'Auto' },
];

const PAYMENT_METHODS: { key: PaymentMethod; label: string }[] = [
  { key: 'tricicoin', label: 'TriciCoin' },
  { key: 'cash', label: 'Efectivo' },
];

export interface RecurringRideFormState {
  pickupAddress: string;
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffAddress: string;
  dropoffLat: number | null;
  dropoffLng: number | null;
  daysOfWeek: number[];
  timeOfDay: string; // "HH:MM"
  serviceType: ServiceTypeSlug;
  paymentMethod: PaymentMethod;
}

export interface RecurringRideFormProps {
  mode: 'create' | 'edit';
  /** Existing ride (only required in edit mode). */
  initialRide?: RecurringRide | null;
  /** Called when the user clicks Save. Parent owns the API call so it
   *  can branch between create and update. */
  onSubmit: (state: RecurringRideFormState) => Promise<void>;
  submitting: boolean;
  errorMessage?: string | null;
}

export function RecurringRideForm({
  mode,
  initialRide,
  onSubmit,
  submitting,
  errorMessage,
}: RecurringRideFormProps) {
  const router = useRouter();
  const { t } = useTranslation('web');
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

  const [pickupAddress, setPickupAddress] = useState(initialRide?.pickup_address ?? '');
  const [pickupLat, setPickupLat] = useState<number | null>(null);
  const [pickupLng, setPickupLng] = useState<number | null>(null);
  const [dropoffAddress, setDropoffAddress] = useState(initialRide?.dropoff_address ?? '');
  const [dropoffLat, setDropoffLat] = useState<number | null>(null);
  const [dropoffLng, setDropoffLng] = useState<number | null>(null);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(initialRide?.days_of_week ?? []);
  const [timeOfDay, setTimeOfDay] = useState(initialRide?.time_of_day ?? '08:00');
  const [serviceType, setServiceType] = useState<ServiceTypeSlug>(
    (initialRide?.service_type as ServiceTypeSlug) ?? 'triciclo_basico',
  );
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    (initialRide?.payment_method as PaymentMethod) ?? 'tricicoin',
  );

  // In edit mode, pickup/dropoff are not editable. Mobile shows them as
  // read-only too (EditRecurringRideSheet:101-113). The PostGIS POINT
  // round-trip is fragile + changing the route conceptually creates a
  // different recurring ride — better to delete + recreate.
  const isEdit = mode === 'edit';

  useEffect(() => {
    if (initialRide) {
      setPickupAddress(initialRide.pickup_address);
      setDropoffAddress(initialRide.dropoff_address);
      setDaysOfWeek([...initialRide.days_of_week]);
      setTimeOfDay(initialRide.time_of_day);
      setServiceType(initialRide.service_type as ServiceTypeSlug);
      setPaymentMethod(initialRide.payment_method as PaymentMethod);
    }
  }, [initialRide?.id]);

  function toggleDay(day: number) {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  }

  // Validation mirrors the `canSave` guard in mobile.
  const canSave = isEdit
    ? daysOfWeek.length > 0
    : pickupLat != null && pickupLng != null
      && dropoffLat != null && dropoffLng != null
      && daysOfWeek.length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave || submitting) return;
    await onSubmit({
      pickupAddress,
      pickupLat,
      pickupLng,
      dropoffAddress,
      dropoffLat,
      dropoffLng,
      daysOfWeek,
      timeOfDay,
      serviceType,
      paymentMethod,
    });
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Route — pickup + dropoff (read-only in edit mode) */}
      <div>
        <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
          {t('recurring.route_label', { defaultValue: 'Ruta' })}
        </label>
        {isEdit ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.875rem', background: 'var(--bg-page)', borderRadius: '0.625rem', border: '1px solid var(--border-light)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0 }} aria-hidden="true" />
              <span style={{ fontSize: '0.875rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pickupAddress}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-tertiary)', flexShrink: 0 }} aria-hidden="true" />
              <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dropoffAddress}</span>
            </div>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
              {t('recurring.route_readonly_hint', { defaultValue: 'Para cambiar la ruta, eliminá este viaje y creá uno nuevo.' })}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            <AddressAutocomplete
              label={t('ride.pickup_label', { defaultValue: 'Recogida' })}
              placeholder={t('ride.pickup_placeholder', { defaultValue: '¿Dónde te recogemos?' })}
              value={pickupAddress}
              onSelect={(r) => {
                setPickupAddress(r.address);
                setPickupLat(r.latitude);
                setPickupLng(r.longitude);
              }}
              onClear={() => {
                setPickupAddress('');
                setPickupLat(null);
                setPickupLng(null);
              }}
              mapboxToken={mapboxToken}
            />
            <AddressAutocomplete
              label={t('ride.dropoff_label', { defaultValue: 'Destino' })}
              placeholder={t('ride.dropoff_placeholder', { defaultValue: '¿A dónde vas?' })}
              value={dropoffAddress}
              onSelect={(r) => {
                setDropoffAddress(r.address);
                setDropoffLat(r.latitude);
                setDropoffLng(r.longitude);
              }}
              onClear={() => {
                setDropoffAddress('');
                setDropoffLat(null);
                setDropoffLng(null);
              }}
              mapboxToken={mapboxToken}
            />
          </div>
        )}
      </div>

      {/* Days of week */}
      <div>
        <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
          {t('recurring.days_label', { defaultValue: 'Días' })}
        </label>
        <div role="group" aria-label={t('recurring.days_label', { defaultValue: 'Días' })} style={{ display: 'flex', gap: '0.375rem' }}>
          {[1, 2, 3, 4, 5, 6, 7].map((day) => {
            const isActive = daysOfWeek.includes(day);
            return (
              <button
                key={day}
                type="button"
                onClick={() => toggleDay(day)}
                aria-pressed={isActive}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  border: 'none',
                  background: isActive ? 'var(--primary)' : 'var(--border-light)',
                  color: isActive ? '#fff' : 'var(--text-tertiary)',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {DAY_LABELS[day - 1]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Time */}
      <div>
        <label htmlFor="time-of-day" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
          {t('recurring.time_label', { defaultValue: 'Hora' })}
        </label>
        <input
          id="time-of-day"
          type="time"
          value={timeOfDay}
          onChange={(e) => setTimeOfDay(e.target.value)}
          required
          step={60}
          style={{
            padding: '0.625rem 0.875rem',
            borderRadius: '0.625rem',
            border: '1px solid var(--border)',
            background: 'var(--bg-page)',
            color: 'var(--text-primary)',
            fontSize: '0.95rem',
            fontFamily: 'inherit',
          }}
        />
      </div>

      {/* Service type */}
      <div>
        <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
          {t('recurring.service_label', { defaultValue: 'Vehículo' })}
        </label>
        <div role="radiogroup" aria-label={t('recurring.service_label', { defaultValue: 'Vehículo' })} style={{ display: 'flex', gap: '0.5rem' }}>
          {SERVICE_TYPES.map(({ slug, label }) => {
            const isActive = serviceType === slug;
            return (
              <button
                key={slug}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => setServiceType(slug)}
                style={{
                  flex: 1,
                  padding: '0.625rem 0.5rem',
                  borderRadius: '0.625rem',
                  border: `1px solid ${isActive ? 'var(--primary)' : 'var(--border)'}`,
                  background: isActive ? 'rgba(255,77,0,0.08)' : 'var(--bg-page)',
                  color: isActive ? 'var(--primary)' : 'var(--text-primary)',
                  fontSize: '0.85rem',
                  fontWeight: isActive ? 600 : 500,
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Payment method */}
      <div>
        <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
          {t('recurring.payment_label', { defaultValue: 'Método de pago' })}
        </label>
        <div role="radiogroup" aria-label={t('recurring.payment_label', { defaultValue: 'Método de pago' })} style={{ display: 'flex', gap: '0.5rem' }}>
          {PAYMENT_METHODS.map(({ key, label }) => {
            const isActive = paymentMethod === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => setPaymentMethod(key)}
                style={{
                  flex: 1,
                  padding: '0.625rem 0.5rem',
                  borderRadius: '0.625rem',
                  border: `1px solid ${isActive ? 'var(--primary)' : 'var(--border)'}`,
                  background: isActive ? 'rgba(255,77,0,0.08)' : 'var(--bg-page)',
                  color: isActive ? 'var(--primary)' : 'var(--text-primary)',
                  fontSize: '0.85rem',
                  fontWeight: isActive ? 600 : 500,
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {errorMessage && (
        <p role="alert" style={{ margin: 0, padding: '0.625rem 0.875rem', borderRadius: '0.5rem', background: '#fef2f2', color: '#dc2626', fontSize: '0.85rem' }}>
          {errorMessage}
        </p>
      )}

      <div style={{ display: 'flex', gap: '0.625rem', marginTop: '0.5rem' }}>
        <button
          type="button"
          onClick={() => router.back()}
          disabled={submitting}
          style={{
            flex: 1,
            padding: '0.75rem',
            borderRadius: '0.625rem',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {t('common.cancel', { defaultValue: 'Cancelar' })}
        </button>
        <button
          type="submit"
          disabled={!canSave || submitting}
          style={{
            flex: 2,
            padding: '0.75rem',
            borderRadius: '0.625rem',
            border: 'none',
            background: canSave && !submitting ? 'var(--primary)' : 'var(--border-light)',
            color: canSave && !submitting ? 'white' : 'var(--text-tertiary)',
            fontWeight: 700,
            cursor: canSave && !submitting ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting
            ? t('common.saving', { defaultValue: 'Guardando…' })
            : isEdit
              ? t('recurring.save_changes', { defaultValue: 'Guardar cambios' })
              : t('recurring.save', { defaultValue: 'Crear viaje recurrente' })}
        </button>
      </div>
    </form>
  );
}
