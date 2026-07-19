'use client';

import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, useFeatureFlagState } from '@tricigo/api';
import { computeRechargeFeeUsd, computeRechargeChargeUsd } from '@tricigo/utils';

type Recipient = { found: boolean; fullName?: string };
type ResultStatus = 'ok' | 'cancel' | 'processing' | null;
type Provider = 'netopia' | 'stripe';

/** Rate age past which we warn. The Edge Functions hard-reject at 24h, so this
 *  leaves the user a real heads-up window rather than a surprise failure. */
const RATE_STALE_WARN_H = 12;

type EfErrorBody = { ok?: boolean; error?: string; detail?: string; redirectUrl?: string };

/**
 * Pull the server's own message out of a failed functions.invoke().
 *
 * supabase-js wraps a non-2xx in a FunctionsHttpError whose `context` is the raw
 * Response — the JSON body (and therefore the EF's `detail`) is NOT on the error
 * object itself. Without this the page discarded a precise, already-translated
 * message (e.g. "Tipo de cambio USD→CUP no disponible o desactualizado") and
 * showed a generic "no se pudo procesar", which is what made the FX outage
 * undiagnosable from the UI.
 */
async function efErrorBody(err: unknown): Promise<EfErrorBody | null> {
  const ctx = (err as { context?: unknown })?.context;
  if (!ctx || typeof (ctx as Response).json !== 'function') return null;
  try {
    return (await (ctx as Response).json()) as EfErrorBody;
  } catch {
    return null; // non-JSON body (gateway HTML, empty 502, ...)
  }
}

export default function RechargePage() {
  const { t } = useTranslation('web');
  const { value: enabled, loading: flagLoading } = useFeatureFlagState('diaspora_recharge_enabled');

  const [phone, setPhone] = useState('');
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [resolving, setResolving] = useState(false);
  const [amount, setAmount] = useState('');
  const [payerName, setPayerName] = useState('');
  const [email, setEmail] = useState('');
  const [rate, setRate] = useState<number | null>(null);
  const [rateAgeH, setRateAgeH] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<'phone' | 'amount' | 'name' | 'email' | null>(null);
  const [btnHover, setBtnHover] = useState(false);
  const [status, setStatus] = useState<ResultStatus>(null);
  const [provider, setProvider] = useState<Provider>('netopia');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Current FX rate for the live "will receive" preview.
  //
  // fetched_at is read alongside the rate on purpose. This page used to quote
  // with identical confidence whether the rate was 5 minutes or 5 days old: during
  // the 2026-07-15 feed outage it showed a frozen 660 as if live, and the pay
  // button then failed with a generic error. The recharge Edge Functions reject a
  // rate older than 24h, so the age is not cosmetic — it predicts whether paying
  // will work at all.
  useEffect(() => {
    (async () => {
      const { data } = await getSupabaseClient()
        .from('exchange_rates').select('usd_cup_rate, fetched_at').eq('is_current', true).single();
      if (data?.usd_cup_rate) setRate(Number(data.usd_cup_rate));
      if (data?.fetched_at) {
        // Math.abs: a clock-skewed future timestamp reads as stale, never as fresh.
        setRateAgeH(Math.abs(Date.now() - new Date(data.fetched_at as string).getTime()) / 3_600_000);
      }
    })();
  }, []);

  // Active payment provider — admin switch (platform_config is anon-readable via
  // its RLS pc_select USING(true)). NETOPIA is the default; the page invokes
  // create-<provider>-recharge-intent accordingly.
  useEffect(() => {
    (async () => {
      const { data } = await getSupabaseClient()
        .from('platform_config').select('value').eq('key', 'active_payment_provider').single();
      const v = data?.value;
      const p = typeof v === 'string' ? v.replace(/^"|"$/g, '') : v;
      if (p === 'stripe' || p === 'netopia') setProvider(p);
    })();
  }, []);

  // Read the post-redirect return status (?status=ok|cancel|processing).
  // Stripe redirects to a distinct ok/cancel URL; NETOPIA uses a single redirect
  // with status=processing (the real result arrives async via the IPN webhook).
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('status');
    if (s === 'ok' || s === 'cancel' || s === 'processing') setStatus(s);
  }, []);

  // Normalize the typed phone to +535XXXXXXX for the lookup.
  const canonicalPhone = useCallback(
    (v: string) => `+53${v.replace(/\D/g, '').replace(/^53/, '')}`,
    [],
  );

  const resolve = useCallback((value: string) => {
    if (abortRef.current) abortRef.current.abort();
    if (value.replace(/\D/g, '').length < 8) { setRecipient(null); setResolving(false); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setResolving(true);
    getSupabaseClient().functions
      .invoke('resolve-recharge-recipient', { body: { phone: canonicalPhone(value) } })
      .then(({ data }) => { if (!controller.signal.aborted) setRecipient(data as Recipient); })
      .catch(() => { if (!controller.signal.aborted) setRecipient({ found: false }); })
      .finally(() => { if (!controller.signal.aborted) setResolving(false); });
  }, [canonicalPhone]);

  function onPhoneChange(v: string) {
    setPhone(v);
    setRecipient(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => resolve(v), 400);
  }

  const amt = Number(amount) || 0;
  // Single source of truth for the recharge fee — the SAME helper the mobile app
  // uses (@tricigo/utils: 3% with a $0.50 floor, additive), so the displayed
  // commission is guaranteed identical to the in-app recharge.
  const fee = computeRechargeFeeUsd(amt);
  const total = computeRechargeChargeUsd(amt);
  const willReceive = rate && amt > 0 ? Math.round(amt * rate) : 0;

  // Human age of the quoted rate. Coarse on purpose — the useful signal is the
  // order of magnitude ("a few minutes" vs "3 days"), not the exact minute.
  const rateAge = rateAgeH === null ? null
    : rateAgeH < 1 ? t('recharge.rate_ago_minutes')
    : rateAgeH < 24 ? t('recharge.rate_ago_hours', { count: Math.round(rateAgeH) })
    : t('recharge.rate_ago_days', { count: Math.round(rateAgeH / 24) });
  const rateStale = rateAgeH !== null && rateAgeH >= RATE_STALE_WARN_H;
  const amountTooLow = amt > 0 && amt < 20;
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const payerNameValid = payerName.trim().length >= 2;
  const canPay = !!recipient?.found && amt >= 20 && payerNameValid && emailValid;

  async function handlePay() {
    setError(null);
    if (!canPay) { setError(t('recharge.error')); return; }
    setSubmitting(true);
    try {
      const { data, error: efErr } = await getSupabaseClient().functions.invoke(`create-${provider}-recharge-intent`, {
        body: { phone: canonicalPhone(phone), amount_usd: amt, payer_email: email, payer_name: payerName.trim() },
      });
      // Prefer the server's own message. On a non-2xx it lives in the Response
      // body behind efErr.context; on a 200-with-ok:false it is already in data.
      const body: EfErrorBody | null = efErr ? await efErrorBody(efErr) : (data as EfErrorBody);
      if (efErr || !body?.ok || !body.redirectUrl) {
        // region_unsupported is the one detail the EFs return in English, and this
        // page is Spanish-first for the diaspora — translate that one, pass the
        // rest through (they are already user-facing Spanish).
        const msg = body?.error === 'region_unsupported'
          ? t('recharge.error_region')
          : (body?.detail ?? t('recharge.error'));
        setError(msg);
        setSubmitting(false);
        return;
      }
      window.location.href = body.redirectUrl; // → provider hosted page (NETOPIA / Stripe)
    } catch {
      setError(t('recharge.error'));
      setSubmitting(false);
    }
  }

  // ── styles ──
  const fieldWrap = (key: 'phone' | 'amount' | 'name' | 'email', invalid = false): CSSProperties => ({
    display: 'flex', alignItems: 'center',
    borderRadius: 12,
    border: `1.5px solid ${invalid ? 'var(--error, #d14343)' : focused === key ? 'var(--primary)' : 'var(--border)'}`,
    background: 'var(--bg-card)',
    boxShadow: focused === key && !invalid ? '0 0 0 3px var(--primary-alpha-10, rgba(255,77,0,0.12))' : 'none',
    transition: 'border-color 160ms, box-shadow 160ms',
    overflow: 'hidden',
  });
  const prefix: CSSProperties = {
    padding: '0 0.85rem', height: 50, display: 'flex', alignItems: 'center',
    color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.95rem',
    borderRight: '1px solid var(--border-light)', background: 'var(--bg-hover, transparent)',
    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  };
  const inputBare: CSSProperties = {
    flex: 1, height: 50, border: 'none', outline: 'none', background: 'transparent',
    color: 'var(--text-primary)', fontSize: '1rem', padding: '0 0.9rem', minWidth: 0,
    fontFamily: 'inherit',
  };
  const label: CSSProperties = {
    fontWeight: 600, fontSize: '0.82rem', color: 'var(--text-secondary)',
    marginBottom: '0.4rem', display: 'block', letterSpacing: '0.01em',
  };
  const helper: CSSProperties = { fontSize: '0.76rem', color: 'var(--text-tertiary)', marginTop: '0.4rem' };

  // While the flag is still resolving, show a spinner — NOT "no disponible".
  // (The flag's false default would otherwise flash the unavailable message for
  // a frame before the real value arrives.)
  if (flagLoading) {
    return (
      <main style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <span
          className="tg-flag-spin"
          aria-label="Cargando"
          style={{ width: 30, height: 30, border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', display: 'inline-block' }}
        />
        <style>{'.tg-flag-spin{animation:tg-flag-spin 0.8s linear infinite}@keyframes tg-flag-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.tg-flag-spin{animation:none}}'}</style>
      </main>
    );
  }

  if (!enabled) {
    return (
      <main style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.95rem' }}>
          {t('recharge.unavailable', { defaultValue: 'No disponible por el momento.' })}
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 460, margin: '0 auto', padding: '2.5rem 1.25rem 3.5rem' }}>
      {/* Identity */}
      <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
        <div style={{ fontSize: '1.35rem', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: '0.85rem' }}>
          Trici<span style={{ color: 'var(--primary)' }}>Go</span>
        </div>
        <h1 style={{ fontSize: '1.7rem', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.15, margin: 0 }}>
          {t('recharge.title')}
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', margin: '0.5rem 0 0', lineHeight: 1.5 }}>
          {t('recharge.subtitle')}
        </p>
      </div>

      {/* Result banner (post-Checkout return) */}
      {status && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.85rem 1rem', marginBottom: '1.25rem',
          borderRadius: 12, fontSize: '0.9rem', fontWeight: 600,
          border: `1px solid ${status === 'ok' ? 'var(--success, #1a7f55)' : 'var(--border)'}`,
          background: status === 'ok' ? 'var(--success-alpha-10, rgba(26,127,85,0.1))' : 'var(--bg-card)',
          color: status === 'ok' ? 'var(--success, #1a7f55)' : 'var(--text-secondary)',
        }}>
          {status === 'ok' ? <IconCheck color="var(--success, #1a7f55)" /> : <IconInfo />}
          {status === 'ok'
            ? t('recharge.success')
            : status === 'processing'
              ? t('recharge.processing')
              : t('recharge.cancelled')}
        </div>
      )}

      {/* Card */}
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 18,
        padding: '1.5rem 1.35rem', boxShadow: '0 6px 24px rgba(0,0,0,0.06)',
      }}>
        {/* 1 — recipient phone */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label htmlFor="rec-phone" style={label}>{t('recharge.recipient_phone')}</label>
          <div style={fieldWrap('phone')}>
            <span style={prefix}>+53</span>
            <input
              id="rec-phone" value={phone} onChange={(e) => onPhoneChange(e.target.value)}
              onFocus={() => setFocused('phone')} onBlur={() => setFocused(null)}
              inputMode="numeric" autoComplete="off" placeholder="5 1234567"
              aria-label={t('recharge.recipient_phone')} style={inputBare}
            />
          </div>
          {resolving && <p style={helper}>{t('recharge.resolving', { defaultValue: 'Buscando…' })}</p>}
          {!resolving && recipient && (
            <p style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.5rem',
              fontSize: '0.86rem', fontWeight: 600,
              color: recipient.found ? 'var(--success, #1a7f55)' : 'var(--error, #d14343)',
            }}>
              {recipient.found ? <IconCheck color="var(--success, #1a7f55)" /> : <IconX />}
              {recipient.found ? t('recharge.recipient_found', { name: recipient.fullName }) : t('recharge.recipient_not_found')}
            </p>
          )}
        </div>

        {/* 2 — amount */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label htmlFor="rec-amount" style={label}>{t('recharge.amount')}</label>
          <div style={fieldWrap('amount', amountTooLow)}>
            <span style={prefix}>$</span>
            <input
              id="rec-amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              onFocus={() => setFocused('amount')} onBlur={() => setFocused(null)}
              inputMode="decimal" autoComplete="off" placeholder="20"
              aria-label={t('recharge.amount')} style={{ ...inputBare, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}
            />
            <span style={{ ...prefix, borderRight: 'none', borderLeft: '1px solid var(--border-light)', fontSize: '0.85rem' }}>USD</span>
          </div>
          <p style={{ ...helper, color: amountTooLow ? 'var(--error, #d14343)' : 'var(--text-tertiary)' }}>
            {t('recharge.amount_min')}
          </p>
        </div>

        {/* 3 — summary (the trust centerpiece: clear fees) */}
        <div style={{
          background: 'var(--bg-hover, rgba(0,0,0,0.03))', borderRadius: 14, padding: '0.9rem 1rem', marginBottom: '1.25rem',
        }}>
          <SummaryRow
            label={t('recharge.rate')}
            value={rate ? `${rate.toLocaleString('es-CU')} CUP / USD` : '—'}
            hint={rate && rateAge ? t('recharge.rate_updated', { ago: rateAge }) : undefined}
          />
          <SummaryRow label={t('recharge.fee')} value={`$${fee.toFixed(2)}`} />
          <SummaryRow label={t('recharge.total')} value={`$${total.toFixed(2)}`} bold />
          <div style={{ height: 1, background: 'var(--border-light)', margin: '0.65rem 0' }} />
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', fontWeight: 600 }}>{t('recharge.will_receive')}</span>
            <span style={{ color: 'var(--primary)', fontWeight: 800, fontSize: '1.15rem', fontVariantNumeric: 'tabular-nums' }}>
              {willReceive.toLocaleString('es-CU')} TriciCoin
            </span>
          </div>

          {/* Stale-rate notice. Advisory, never blocking: the Edge Function still
              accepts the payment under 24h, so refusing here would cost a real
              recharge to prevent a small quote drift. Uses an icon + wording (not
              colour alone) so it survives colour-blindness and greyscale. */}
          {rateStale && rateAgeH !== null && (
            <div
              role="status"
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.45rem',
                marginTop: '0.7rem', padding: '0.55rem 0.65rem',
                borderRadius: 10,
                border: '1px solid var(--warning-border, rgba(180,120,0,0.35))',
                background: 'var(--warning-bg, rgba(255,176,32,0.10))',
                color: 'var(--warning-text, #8a5a00)',
                fontSize: '0.78rem', lineHeight: 1.45,
              }}
            >
              <span style={{ flexShrink: 0, marginTop: 1 }}><IconInfo /></span>
              <span>
                {rateAgeH! < 24
                  ? t('recharge.rate_stale_hours', { count: Math.round(rateAgeH!) })
                  : t('recharge.rate_stale_days', { count: Math.round(rateAgeH! / 24) })}
              </span>
            </div>
          )}
        </div>

        {/* 4 — payer name */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label htmlFor="rec-name" style={label}>{t('recharge.payer_name')}</label>
          <div style={fieldWrap('name', payerName.length > 0 && !payerNameValid)}>
            <input
              id="rec-name" value={payerName} onChange={(e) => setPayerName(e.target.value)}
              onFocus={() => setFocused('name')} onBlur={() => setFocused(null)}
              type="text" autoComplete="name" maxLength={60} placeholder="Nombre y apellido"
              aria-label={t('recharge.payer_name')} style={inputBare}
            />
          </div>
        </div>

        {/* 5 — payer email */}
        <div style={{ marginBottom: '1.4rem' }}>
          <label htmlFor="rec-email" style={label}>{t('recharge.payer_email')}</label>
          <div style={fieldWrap('email', email.length > 3 && !emailValid)}>
            <input
              id="rec-email" value={email} onChange={(e) => setEmail(e.target.value)}
              onFocus={() => setFocused('email')} onBlur={() => setFocused(null)}
              type="email" inputMode="email" autoComplete="email" placeholder="correo@ejemplo.com"
              aria-label={t('recharge.payer_email')} style={inputBare}
            />
          </div>
        </div>

        {error && (
          <p role="alert" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--error, #d14343)', fontSize: '0.86rem', marginBottom: '0.85rem', fontWeight: 600 }}>
            <IconX /> {error}
          </p>
        )}

        {/* 5 — pay */}
        <button
          onClick={handlePay} disabled={submitting || !canPay}
          onMouseEnter={() => setBtnHover(true)} onMouseLeave={() => setBtnHover(false)}
          style={{
            width: '100%', height: 52, borderRadius: 13, border: 'none',
            background: 'var(--primary)', color: '#fff', fontWeight: 800, fontSize: '1.02rem',
            cursor: submitting || !canPay ? 'default' : 'pointer',
            opacity: submitting || !canPay ? 0.55 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
            transition: 'transform 160ms, filter 160ms, opacity 160ms',
            transform: btnHover && canPay && !submitting ? 'translateY(-1px)' : 'none',
            filter: btnHover && canPay && !submitting ? 'brightness(1.05)' : 'none',
          }}
        >
          {submitting && <Spinner />}
          {submitting ? `${t('recharge.pay')}…` : t('recharge.pay')}
        </button>

        {/* 6 — secure-payment trust footer (provider-agnostic: NETOPIA or Stripe) */}
        <p style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', color: 'var(--text-tertiary)', fontSize: '0.78rem', margin: '1rem 0 0' }}>
          <IconLock /> {t('recharge.payment_secured')}
        </p>
      </div>
    </main>
  );
}

function SummaryRow({ label, value, bold, hint }: { label: string; value: string; bold?: boolean; hint?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0.22rem 0' }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
        {/* Age sits beside the rate, not on its own row: it qualifies this number
            specifically, and a separate row would read as another cost line. */}
        {hint && <span style={{ color: 'var(--text-tertiary, var(--text-secondary))', fontSize: '0.76rem' }}>{hint}</span>}
        <span style={{ color: 'var(--text-primary)', fontSize: '0.92rem', fontWeight: bold ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      </span>
    </div>
  );
}

function IconCheck({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function IconX() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--error, #d14343)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
function IconInfo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
function IconLock() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
function Spinner() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="tg-spin">
      <style>{'.tg-spin{animation:tg-spin .8s linear infinite}@keyframes tg-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.tg-spin{animation:none}}'}</style>
      <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.35)" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
