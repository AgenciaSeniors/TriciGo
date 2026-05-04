'use client';

/**
 * Create recurring ride — web equivalent of the mobile
 * `<CreateRecurringRideSheet />` (apps/client/src/components/
 * CreateRecurringRideSheet.tsx). Reuses the shared `<RecurringRideForm />`
 * so create + edit have identical layout, validation and field set.
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, recurringRideService } from '@tricigo/api';
import { RecurringRideForm, type RecurringRideFormState } from '@/components/RecurringRideForm';

export default function CreateRecurringRidePage() {
  const router = useRouter();
  const { t } = useTranslation('web');

  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        router.replace('/login');
        return;
      }
      setUserId(session.user.id);
      setAuthLoading(false);
    });
  }, [router]);

  async function handleSubmit(state: RecurringRideFormState) {
    if (!userId) return;
    if (state.pickupLat == null || state.pickupLng == null
      || state.dropoffLat == null || state.dropoffLng == null) {
      setError(t('recurring.error_route_required', {
        defaultValue: 'Seleccioná recogida y destino del autocompletado.',
      }));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await recurringRideService.createRecurringRide({
        user_id: userId,
        pickup_latitude: state.pickupLat,
        pickup_longitude: state.pickupLng,
        pickup_address: state.pickupAddress,
        dropoff_latitude: state.dropoffLat,
        dropoff_longitude: state.dropoffLng,
        dropoff_address: state.dropoffAddress,
        service_type: state.serviceType,
        payment_method: state.paymentMethod,
        days_of_week: state.daysOfWeek,
        time_of_day: state.timeOfDay,
      });
      router.replace('/profile/recurring-rides');
    } catch (err: unknown) {
      const errObj = err as { message?: string; code?: string } | null;
      if (errObj?.code === 'MAX_RECURRING' || errObj?.message?.includes('max')) {
        setError(t('recurring.max_reached', {
          defaultValue: 'Alcanzaste el máximo de viajes recurrentes activos.',
        }));
      } else {
        setError(errObj?.message ?? t('recurring.create_failed', {
          defaultValue: 'No se pudo crear el viaje recurrente. Intentá de nuevo.',
        }));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (authLoading) {
    return (
      <main style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('web.loading', { defaultValue: 'Cargando...' })}</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1.5rem' }}>
        <Link
          href="/profile/recurring-rides"
          aria-label={t('common.back', { defaultValue: 'Volver' })}
          style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
          {t('recurring.create', { defaultValue: 'Crear viaje recurrente' })}
        </h1>
      </div>

      <RecurringRideForm
        mode="create"
        onSubmit={handleSubmit}
        submitting={submitting}
        errorMessage={error}
      />
    </main>
  );
}
