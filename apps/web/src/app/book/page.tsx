'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { HAVANA_PRESETS, formatCUP } from '@tricigo/utils';
import type { LocationPreset } from '@tricigo/utils';
import { rideService } from '@tricigo/api';
import type { FareEstimate, ServiceTypeSlug, PaymentMethod } from '@tricigo/types';

const SERVICE_TYPE_KEYS: { slug: ServiceTypeSlug; icon: string; labelKey: string }[] = [
  { slug: 'triciclo_basico', icon: '\u{1F6FA}', labelKey: 'book.service_triciclo' },
  { slug: 'moto_standard', icon: '\u{1F3CD}\uFE0F', labelKey: 'book.service_moto' },
  { slug: 'auto_standard', icon: '\u{1F697}', labelKey: 'book.service_auto' },
];

export default function BookPage() {
  const router = useRouter();
  const { t } = useTranslation('web');
  const [pickup, setPickup] = useState<LocationPreset | null>(null);
  const [dropoff, setDropoff] = useState<LocationPreset | null>(null);
  const [serviceType, setServiceType] = useState<ServiceTypeSlug>('triciclo_basico');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [estimate, setEstimate] = useState<FareEstimate | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canEstimate = pickup && dropoff && pickup.label !== dropoff.label;

  async function handleEstimate() {
    if (!pickup || !dropoff) return;
    setIsEstimating(true);
    setError(null);
    try {
      const result = await rideService.getLocalFareEstimate({
        service_type: serviceType,
        pickup_lat: pickup.latitude,
        pickup_lng: pickup.longitude,
        dropoff_lat: dropoff.latitude,
        dropoff_lng: dropoff.longitude,
      });
      setEstimate(result);
    } catch (err) {
      setError(t('book.error_estimate'));
      console.error(err);
    } finally {
      setIsEstimating(false);
    }
  }

  async function handleRequest() {
    if (!pickup || !dropoff || !estimate) return;
    setIsRequesting(true);
    setError(null);
    try {
      const ride = await rideService.createRide({
        service_type: serviceType,
        payment_method: paymentMethod,
        pickup_latitude: pickup.latitude,
        pickup_longitude: pickup.longitude,
        pickup_address: `${pickup.label} — ${pickup.address}`,
        dropoff_latitude: dropoff.latitude,
        dropoff_longitude: dropoff.longitude,
        dropoff_address: `${dropoff.label} — ${dropoff.address}`,
        estimated_fare_cup: estimate.estimated_fare_cup,
        estimated_distance_m: estimate.estimated_distance_m,
        estimated_duration_s: estimate.estimated_duration_s,
      });
      router.push(`/track/${ride.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('book.error_unknown');
      if (msg.includes('Not authenticated') || msg.includes('Missing')) {
        setError(t('book.error_auth'));
      } else {
        setError(t('book.error_request'));
      }
      console.error(err);
    } finally {
      setIsRequesting(false);
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: 500, width: '100%' }}>
        <Link
          href="/"
          style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}
        >
          {t('book.back')}
        </Link>

        <h1 style={{ fontSize: '2rem', fontWeight: 800, marginTop: '1rem', marginBottom: '0.5rem' }}>
          {t('book.title')}
        </h1>
        <p style={{ color: '#888', marginBottom: '2rem' }}>
          {t('book.subtitle')}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Pickup selector */}
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
              {t('book.pickup_label')}
            </label>
            <select
              value={pickup?.label ?? ''}
              onChange={(e) => {
                const preset = HAVANA_PRESETS.find((p) => p.label === e.target.value) ?? null;
                setPickup(preset);
                setEstimate(null);
              }}
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                borderRadius: '0.75rem',
                border: '1px solid #ddd',
                fontSize: '1rem',
                outline: 'none',
                background: 'white',
                cursor: 'pointer',
              }}
            >
              <option value="">{t('book.pickup_placeholder')}</option>
              {HAVANA_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label} — {p.address}
                </option>
              ))}
            </select>
          </div>

          {/* Dropoff selector */}
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
              {t('book.dropoff_label')}
            </label>
            <select
              value={dropoff?.label ?? ''}
              onChange={(e) => {
                const preset = HAVANA_PRESETS.find((p) => p.label === e.target.value) ?? null;
                setDropoff(preset);
                setEstimate(null);
              }}
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                borderRadius: '0.75rem',
                border: '1px solid #ddd',
                fontSize: '1rem',
                outline: 'none',
                background: 'white',
                cursor: 'pointer',
              }}
            >
              <option value="">{t('book.dropoff_placeholder')}</option>
              {HAVANA_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label} — {p.address}
                </option>
              ))}
            </select>
          </div>

          {/* Service type selector */}
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              {t('book.service_type')}
            </label>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              {SERVICE_TYPE_KEYS.map((svc) => (
                <button
                  key={svc.slug}
                  type="button"
                  onClick={() => {
                    setServiceType(svc.slug);
                    setEstimate(null);
                  }}
                  style={{
                    flex: 1,
                    padding: '0.75rem',
                    borderRadius: '0.75rem',
                    border: serviceType === svc.slug ? '2px solid var(--primary)' : '1px solid #ddd',
                    background: serviceType === svc.slug ? '#FFF5F0' : 'white',
                    cursor: 'pointer',
                    textAlign: 'center',
                    fontSize: '0.875rem',
                    fontWeight: serviceType === svc.slug ? 700 : 400,
                  }}
                >
                  <span style={{ fontSize: '1.5rem', display: 'block', marginBottom: '0.25rem' }}>
                    {svc.icon}
                  </span>
                  {t(svc.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Estimate button */}
          <button
            disabled={!canEstimate || isEstimating}
            onClick={handleEstimate}
            style={{
              width: '100%',
              padding: '1rem',
              borderRadius: '0.75rem',
              border: 'none',
              background: canEstimate && !isEstimating ? 'var(--primary)' : '#ccc',
              color: 'white',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: canEstimate && !isEstimating ? 'pointer' : 'not-allowed',
              marginTop: '0.5rem',
            }}
          >
            {isEstimating ? t('book.estimating') : t('book.get_estimate')}
          </button>

          {/* Error message */}
          {error && (
            <p style={{ color: '#e04400', fontSize: '0.875rem', textAlign: 'center' }}>
              {error}
            </p>
          )}

          {/* Fare estimate card */}
          {estimate && (
            <div
              style={{
                padding: '1.25rem',
                borderRadius: '0.75rem',
                border: '2px solid var(--primary)',
                background: '#FFF5F0',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.875rem', color: '#666' }}>{t('book.estimated_fare')}</span>
                <span style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--primary)' }}>
                  {formatCUP(estimate.estimated_fare_cup)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: '#666' }}>
                <span>{'\u{1F4CF}'} {(estimate.estimated_distance_m / 1000).toFixed(1)} km</span>
                <span>{'\u23F1\uFE0F'} {Math.round(estimate.estimated_duration_s / 60)} min</span>
                {estimate.surge_multiplier > 1 && (
                  <span style={{ color: 'var(--primary)', fontWeight: 700 }}>
                    {'\u26A1'} {estimate.surge_multiplier}x
                  </span>
                )}
              </div>

              {/* Payment method */}
              <div style={{ marginTop: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                  {t('book.payment_method')}
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('cash')}
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '0.5rem',
                      border: paymentMethod === 'cash' ? '2px solid var(--primary)' : '1px solid #ddd',
                      background: paymentMethod === 'cash' ? '#FFF5F0' : 'white',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      fontWeight: paymentMethod === 'cash' ? 700 : 400,
                    }}
                  >
                    {'\u{1F4B5}'} {t('book.payment_cash')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('tricicoin')}
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '0.5rem',
                      border: paymentMethod === 'tricicoin' ? '2px solid var(--primary)' : '1px solid #ddd',
                      background: paymentMethod === 'tricicoin' ? '#FFF5F0' : 'white',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      fontWeight: paymentMethod === 'tricicoin' ? 700 : 400,
                    }}
                  >
                    {'\u{1FA99}'} {t('book.payment_tricicoin')}
                  </button>
                </div>
              </div>

              {/* Request button */}
              <button
                onClick={handleRequest}
                disabled={isRequesting}
                style={{
                  width: '100%',
                  padding: '1rem',
                  borderRadius: '0.75rem',
                  border: 'none',
                  background: isRequesting ? '#ccc' : 'var(--primary)',
                  color: 'white',
                  fontSize: '1rem',
                  fontWeight: 700,
                  cursor: isRequesting ? 'not-allowed' : 'pointer',
                  marginTop: '1rem',
                }}
              >
                {isRequesting ? t('book.requesting') : t('book.request_ride')}
              </button>
            </div>
          )}
        </div>

        <p
          style={{
            marginTop: '2rem',
            padding: '1rem',
            background: '#f9f9f9',
            borderRadius: '0.75rem',
            fontSize: '0.875rem',
            color: '#888',
            textAlign: 'center',
          }}
        >
          {t('book.download_cta')}
        </p>
      </div>
    </main>
  );
}
