'use client';

import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, useFeatureFlag } from '@tricigo/api';

export default function RechargePage() {
  const { t } = useTranslation('web');
  const enabled = useFeatureFlag('diaspora_recharge_enabled');

  const [phone, setPhone] = useState('');
  const [recipient, setRecipient] = useState<{ found: boolean; fullName?: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [email, setEmail] = useState('');
  const [rate, setRate] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Current FX rate for the live "will receive" preview.
  useEffect(() => {
    (async () => {
      const { data } = await getSupabaseClient().from('exchange_rates').select('usd_cup_rate').eq('is_current', true).single();
      if (data?.usd_cup_rate) setRate(Number(data.usd_cup_rate));
    })();
  }, []);

  // Normalize the typed phone to +535XXXXXXX for the lookup.
  const canonicalPhone = useCallback((v: string) => `+53${v.replace(/\D/g, '').replace(/^53/, '')}`, []);

  const resolve = useCallback((value: string) => {
    if (abortRef.current) abortRef.current.abort();
    if (value.replace(/\D/g, '').length < 8) { setRecipient(null); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    getSupabaseClient().functions
      .invoke('resolve-recharge-recipient', { body: { phone: canonicalPhone(value) } })
      .then(({ data }) => { if (!controller.signal.aborted) setRecipient(data as { found: boolean; fullName?: string }); })
      .catch(() => { if (!controller.signal.aborted) setRecipient({ found: false }); });
  }, [canonicalPhone]);

  function onPhoneChange(v: string) {
    setPhone(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => resolve(v), 400);
  }

  const amt = Number(amount) || 0;
  const fee = amt > 0 ? Math.max(Number((amt * 0.03).toFixed(2)), 0.5) : 0;
  const willReceive = rate && amt > 0 ? Math.round(amt * rate) : 0;
  const canPay = !!recipient?.found && amt >= 20 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  async function handlePay() {
    setError(null);
    if (!canPay) { setError(t('recharge.error')); return; }
    setSubmitting(true);
    try {
      const { data, error: efErr } = await getSupabaseClient().functions.invoke('create-stripe-recharge-intent', {
        body: { phone: canonicalPhone(phone), amount_usd: amt, payer_email: email },
      });
      const res = data as { ok?: boolean; redirectUrl?: string };
      if (efErr || !res?.ok || !res.redirectUrl) throw new Error('failed');
      window.location.href = res.redirectUrl; // → Stripe Checkout
    } catch {
      setError(t('recharge.error'));
      setSubmitting(false);
    }
  }

  const inputStyle: CSSProperties = {
    width: '100%', padding: '0.7rem 0.9rem', margin: '0.4rem 0', borderRadius: '0.6rem',
    border: '1.5px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: '0.95rem',
  };

  if (!enabled) {
    return <main style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>—</main>;
  }

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2.5rem 1.25rem' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '0.25rem' }}>{t('recharge.title')}</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>{t('recharge.subtitle')}</p>

      <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>{t('recharge.recipient_phone')}</label>
      <input value={phone} onChange={(e) => onPhoneChange(e.target.value)} inputMode="numeric" placeholder="+53 …" style={inputStyle} />
      {recipient && (
        <p style={{ fontSize: '0.85rem', color: recipient.found ? 'var(--primary)' : 'var(--error, #c0392b)', margin: '0 0 1rem' }}>
          {recipient.found ? t('recharge.recipient_found', { name: recipient.fullName }) : t('recharge.recipient_not_found')}
        </p>
      )}

      <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>{t('recharge.amount')}</label>
      <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder={t('recharge.amount_min')} style={{ ...inputStyle, marginBottom: '0.75rem' }} />

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: '0.6rem', padding: '0.9rem', marginBottom: '1rem', fontSize: '0.9rem' }}>
        <Row label={t('recharge.rate')} value={rate ? `${rate} CUP / USD` : '—'} />
        <Row label={t('recharge.fee')} value={`$${fee.toFixed(2)}`} />
        <Row label={t('recharge.total')} value={`$${(amt + fee).toFixed(2)}`} />
        <Row label={t('recharge.will_receive')} value={`${willReceive.toLocaleString('es-CU')} TriciCoin`} strong />
      </div>

      <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>{t('recharge.payer_email')}</label>
      <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="correo@ejemplo.com" style={{ ...inputStyle, marginBottom: '1rem' }} />

      {error && <p style={{ color: 'var(--error, #c0392b)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>{error}</p>}

      <button
        onClick={handlePay}
        disabled={submitting || !canPay}
        style={{ width: '100%', padding: '0.9rem', borderRadius: '0.6rem', border: 'none', background: 'var(--primary)', color: '#fff', fontWeight: 700, fontSize: '1rem', cursor: submitting || !canPay ? 'default' : 'pointer', opacity: submitting || !canPay ? 0.6 : 1 }}
      >
        {t('recharge.pay')}
      </button>
      <p style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.78rem', marginTop: '0.75rem' }}>🔒 {t('recharge.secured_by_stripe')}</p>
    </main>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.2rem 0' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontWeight: strong ? 800 : 600, color: strong ? 'var(--primary)' : 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
