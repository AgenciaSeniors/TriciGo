'use client';

/**
 * TipFlow — post-ride tip UI for the web client (parity with mobile
 * `apps/client/src/components/RideCompleteView.tsx:582-643`).
 *
 * Renders three preset amounts + an "Otro monto" expander that opens an
 * inline numeric input. Calls `rideService.addTip(rideId, userId, amount)`
 * with the amount in TRC cents (the unit the wallet ledger stores). On
 * success, surfaces a confirmation badge and notifies the parent so it
 * can refetch the ride and hide the flow.
 *
 * Visibility constraints (decided by the parent — pass `visible` only
 * when they're all true):
 *   - ride.status === 'completed'
 *   - ride.payment_method !== 'cash' (cash tips happen offline, in person)
 *   - !ride.tip_amount (don't re-prompt if the user already tipped)
 */
import { useState } from 'react';
import { rideService } from '@tricigo/api';
import { formatTRC } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';

const PRESET_AMOUNTS_CENTS = [5000, 10000, 20000];
// Mirror of `MAX_TIP_AMOUNT` in apps/client/src/config/ride.ts:12 — kept
// as a plain constant here because @tricigo/utils doesn't export it and
// duplicating an integer is cheaper than adding a config package round-trip.
const MAX_TIP_AMOUNT_CENTS = 100_000;

export interface TipFlowProps {
  rideId: string;
  userId: string;
  /** Called once the tip is submitted successfully so the parent can
   *  refetch the ride (so `tip_amount` updates and this component
   *  unmounts via its visibility predicate). */
  onTipSubmitted?: () => void;
}

export function TipFlow({ rideId, userId, onTipSubmitted }: TipFlowProps) {
  const { t } = useTranslation('web');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');

  async function submit(amountCents: number) {
    if (sending) return;
    if (amountCents <= 0 || amountCents > MAX_TIP_AMOUNT_CENTS) {
      setError(t('ride.tip_amount_invalid', {
        defaultValue: 'El monto está fuera del rango permitido.',
      }));
      return;
    }
    setSending(true);
    setError(null);
    try {
      await rideService.addTip(rideId, userId, amountCents);
      setSuccess(true);
      // Give the user a beat to see the "Gracias" badge before the
      // parent refetches and unmounts us.
      setTimeout(() => onTipSubmitted?.(), 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setError(msg || t('ride.tip_failed', { defaultValue: 'No se pudo enviar la propina. Intenta de nuevo.' }));
    } finally {
      setSending(false);
    }
  }

  if (success) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          padding: '0.75rem',
          margin: '0.5rem 0',
          borderRadius: '999px',
          background: 'rgba(22,163,74,0.12)',
          color: '#16a34a',
          fontWeight: 600,
        }}
      >
        <span aria-hidden="true">✓</span>
        {t('ride.thanks_tip', { defaultValue: 'Gracias por tu propina' })}
      </div>
    );
  }

  return (
    <section
      style={{
        margin: '0.75rem 0',
        padding: '1rem',
        borderRadius: '0.75rem',
        border: '1px solid var(--border-light)',
        background: 'var(--bg-card)',
      }}
    >
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', textAlign: 'center' }}>
        {t('ride.tip_title', { defaultValue: '¿Querés dejar propina?' })}
      </p>

      {/* Preset buttons + "Otro monto" expander */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center' }}>
        {PRESET_AMOUNTS_CENTS.map((amount) => (
          <button
            key={amount}
            type="button"
            disabled={sending}
            onClick={() => submit(amount)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '999px',
              border: '1px solid var(--border)',
              background: 'var(--bg-page)',
              color: 'var(--text-primary)',
              fontSize: '0.85rem',
              cursor: sending ? 'not-allowed' : 'pointer',
              opacity: sending ? 0.6 : 1,
            }}
          >
            {formatTRC(amount)}
          </button>
        ))}
        <button
          type="button"
          disabled={sending}
          onClick={() => setCustomOpen((v) => !v)}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '999px',
            border: '1px solid var(--border)',
            background: 'var(--bg-page)',
            color: 'var(--text-primary)',
            fontSize: '0.85rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          <span aria-hidden="true">{customOpen ? '−' : '+'}</span>
          {t('ride.tip_custom', { defaultValue: 'Otro monto' })}
        </button>
      </div>

      {customOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', justifyContent: 'center' }}>
          <input
            type="number"
            inputMode="numeric"
            placeholder={t('ride.tip_custom_placeholder', { defaultValue: 'Monto en TRC' })}
            value={customValue}
            min={0.01}
            step={0.01}
            onChange={(e) => setCustomValue(e.target.value)}
            disabled={sending}
            style={{
              flex: 1,
              maxWidth: 180,
              padding: '0.5rem 0.75rem',
              borderRadius: '0.5rem',
              border: '1px solid var(--border)',
              background: 'var(--bg-page)',
              fontSize: '0.85rem',
            }}
          />
          <button
            type="button"
            disabled={sending || !customValue || parseFloat(customValue) <= 0}
            onClick={() => {
              const trc = parseFloat(customValue);
              if (!trc || trc <= 0) return;
              // Same convention as transfer P2P (PR #78 B2): user types
              // whole TRC, we convert to cents before the API call.
              submit(Math.round(trc * 100));
            }}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: 'none',
              background: 'var(--primary)',
              color: 'white',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: sending ? 'not-allowed' : 'pointer',
              opacity: sending ? 0.6 : 1,
            }}
          >
            {sending ? '...' : t('ride.tip_send', { defaultValue: 'Enviar' })}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'var(--error, #dc2626)', textAlign: 'center' }}>
          {error}
        </p>
      )}
    </section>
  );
}
