'use client';

/**
 * TipFlow — post-ride tip UI for the web client (parity with mobile
 * `apps/client/src/components/RideCompleteView.tsx`).
 *
 * Renders percentage presets (10/15/20%) computed off the ride fare —
 * each chip shows the resulting TRC amount — plus an "Otro monto"
 * field with a live formatted preview. Calls
 * `rideService.addTip(rideId, userId, amount)` with the amount in
 * WHOLE TRC (1 TRC = 1 CUP), the unit the ledger stores and the
 * `add_tip` RPC expects. (The old version multiplied the custom value
 * by 100 — a leftover from the retired TRC-cents model — which charged
 * 100× what the user typed.)
 *
 * Visibility constraints (decided by the parent — pass `visible` only
 * when they're all true):
 *   - ride.status === 'completed'
 *   - ride.payment_method !== 'cash' (cash tips happen offline, in person)
 *   - !ride.tip_amount (don't re-prompt if the user already tipped)
 */
import { useState } from 'react';
import { rideService } from '@tricigo/api';
import { formatTRC, TIP_PERCENT_OPTIONS, tipAmountForPercent } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';

// Mirror of `MAX_TIP_AMOUNT` in packages/utils/src/ride-config.ts (whole TRC).
const MAX_TIP_AMOUNT = 100_000;

export interface TipFlowProps {
  rideId: string;
  userId: string;
  /** Ride fare in CUP (= TRC, 1:1) used to compute the % presets. */
  fareCup: number;
  /** Called once the tip is submitted successfully so the parent can
   *  refetch the ride (so `tip_amount` updates and this component
   *  unmounts via its visibility predicate). */
  onTipSubmitted?: () => void;
}

export function TipFlow({ rideId, userId, fareCup, onTipSubmitted }: TipFlowProps) {
  const { t } = useTranslation('web');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');

  const showPctChips = fareCup > 0;
  const customAmount = parseInt(customValue || '0', 10) || 0;

  async function submit(amount: number) {
    if (sending) return;
    if (amount <= 0 || amount > MAX_TIP_AMOUNT) {
      setError(t('ride.tip_amount_invalid', {
        defaultValue: 'El monto está fuera del rango permitido.',
      }));
      return;
    }
    setSending(true);
    setError(null);
    try {
      await rideService.addTip(rideId, userId, amount);
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

  const chipBase: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.1rem',
    flex: 1,
    padding: '0.6rem 0.5rem',
    borderRadius: '0.75rem',
    border: '1px solid var(--border)',
    background: 'var(--bg-page)',
    color: 'var(--text-primary)',
    cursor: sending ? 'not-allowed' : 'pointer',
    opacity: sending ? 0.6 : 1,
  };

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
      <p style={{ margin: '0 0 0.15rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', textAlign: 'center' }}>
        {t('ride.tip_title', { defaultValue: '¿Quieres dejar propina?' })}
      </p>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.72rem', color: 'var(--text-tertiary, var(--text-secondary))', textAlign: 'center' }}>
        {t('ride.tip_subtitle', { defaultValue: 'El 100% va para tu conductor' })}
      </p>

      {/* Percentage presets — each chip shows the resulting TRC amount. */}
      {showPctChips && (
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {TIP_PERCENT_OPTIONS.map((pct) => {
            const amount = tipAmountForPercent(fareCup, pct);
            return (
              <button
                key={pct}
                type="button"
                disabled={sending}
                onClick={() => submit(amount)}
                aria-label={`${pct}% · ${formatTRC(amount)}`}
                style={chipBase}
              >
                <span style={{ fontSize: '0.95rem', fontWeight: 700 }}>{pct}%</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                  {formatTRC(amount)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* "Otro monto" expander — only when chips are shown; without a
          fare the free field below is already visible. */}
      {showPctChips && (
        <button
          type="button"
          disabled={sending}
          onClick={() => setCustomOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.25rem',
            width: '100%',
            marginTop: '0.5rem',
            padding: '0.4rem',
            border: 'none',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: '0.8rem',
            cursor: 'pointer',
          }}
        >
          <span aria-hidden="true">{customOpen ? '−' : '+'}</span>
          {t('ride.tip_custom', { defaultValue: 'Otro monto' })}
        </button>
      )}

      {/* Free-amount field with a live formatted preview. */}
      {(customOpen || !showPctChips) && (
        <div style={{ marginTop: showPctChips ? '0.25rem' : '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="text"
              inputMode="numeric"
              placeholder={t('ride.tip_custom_placeholder', { defaultValue: 'Escribe un monto en TRC' })}
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value.replace(/[^0-9]/g, ''))}
              disabled={sending}
              style={{
                flex: 1,
                padding: '0.5rem 0.75rem',
                borderRadius: '0.5rem',
                border: '1px solid var(--border)',
                background: 'var(--bg-page)',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
              }}
            />
            <button
              type="button"
              disabled={sending || customAmount <= 0}
              onClick={() => submit(customAmount)}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: '0.5rem',
                border: 'none',
                background: 'var(--primary)',
                color: 'white',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: sending || customAmount <= 0 ? 'not-allowed' : 'pointer',
                opacity: sending || customAmount <= 0 ? 0.6 : 1,
              }}
            >
              {sending ? '…' : t('ride.tip_send', { defaultValue: 'Enviar' })}
            </button>
          </div>
          {customAmount > 0 && (
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.72rem', color: 'var(--text-secondary)', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
              {t('ride.tip_preview', { defaultValue: '= {{amount}}', amount: formatTRC(customAmount) })}
            </p>
          )}
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
