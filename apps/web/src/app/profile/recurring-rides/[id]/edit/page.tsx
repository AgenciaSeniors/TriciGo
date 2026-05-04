'use client';

/**
 * Edit recurring ride — web equivalent of the mobile
 * `<EditRecurringRideSheet />` (apps/client/src/components/
 * EditRecurringRideSheet.tsx). Reuses the shared `<RecurringRideForm />`
 * with `mode='edit'` so pickup/dropoff render read-only — same UX as
 * mobile.
 *
 * Fetch strategy: there's no `getRecurringRideById` in the service, so
 * we list all rides for the current user and filter by id. With
 * MAX_RECURRING=10 (recurring-ride.service.ts:4) the over-fetch is
 * negligible and we avoid adding new RPC surface area.
 */
import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, recurringRideService } from '@tricigo/api';
import type { RecurringRide } from '@tricigo/types';
import { RecurringRideForm, type RecurringRideFormState } from '@/components/RecurringRideForm';

export default function EditRecurringRidePage() {
  const router = useRouter();
  const { t } = useTranslation('web');
  const params = useParams();
  const rideId = params?.id as string | undefined;

  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [ride, setRide] = useState<RecurringRide | null>(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    if (!userId || !rideId) return;
    let cancelled = false;
    (async () => {
      try {
        const all = await recurringRideService.getRecurringRides(userId);
        if (cancelled) return;
        const found = all.find((r) => r.id === rideId) ?? null;
        if (!found) {
          setError(t('recurring.not_found', { defaultValue: 'Viaje recurrente no encontrado.' }));
        }
        setRide(found);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('recurring.load_error', {
            defaultValue: 'No se pudo cargar el viaje recurrente.',
          }));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId, rideId, t]);

  async function handleSubmit(state: RecurringRideFormState) {
    if (!ride) return;
    setSubmitting(true);
    setError(null);
    try {
      // Mirror exact set of editable fields from mobile EditSheet:80-85.
      // Pickup/dropoff/addresses NOT editable in this flow.
      await recurringRideService.updateRecurringRide(ride.id, {
        days_of_week: state.daysOfWeek,
        time_of_day: state.timeOfDay,
        service_type: state.serviceType,
        payment_method: state.paymentMethod,
      });
      router.replace('/profile/recurring-rides');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('recurring.update_failed', {
        defaultValue: 'No se pudo actualizar el viaje recurrente.',
      });
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  if (authLoading || loading) {
    return (
      <main style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('web.loading', { defaultValue: 'Cargando...' })}</p>
      </main>
    );
  }

  if (!ride) {
    return (
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          {error ?? t('recurring.not_found', { defaultValue: 'Viaje recurrente no encontrado.' })}
        </p>
        <Link
          href="/profile/recurring-rides"
          style={{
            display: 'inline-block',
            padding: '0.625rem 1.25rem',
            background: 'var(--primary)',
            color: 'white',
            borderRadius: 'var(--radius-md, 0.625rem)',
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          {t('common.back', { defaultValue: 'Volver' })}
        </Link>
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
          {t('recurring.edit', { defaultValue: 'Editar viaje recurrente' })}
        </h1>
      </div>

      <RecurringRideForm
        mode="edit"
        initialRide={ride}
        onSubmit={handleSubmit}
        submitting={submitting}
        errorMessage={error}
      />
    </main>
  );
}
