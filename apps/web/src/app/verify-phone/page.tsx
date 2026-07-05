'use client';

/**
 * Verify-phone (web) — parity con apps/client/app/(auth)/verify-phone.
 * Links a phone number to an OAuth (Google/Apple) account that has none, so
 * the rider is reachable during the trip + emergencies. Reached from the
 * callback routing and the session guard.
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { authService, getSupabaseClient } from '@tricigo/api';
import { isValidCubanPhone, normalizeCubanPhone } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useAuth } from '../providers';
import { DEMO_MODE, DEMO_DIAL_CODES, isValidDemoPhone, normalizeDemoPhone } from '@/config/demo';

type Step = 'phone' | 'otp';

export default function VerifyPhonePage() {
  const router = useRouter();
  const { t } = useTranslation('common');
  const { user, isLoading, isAuthenticated, signOut } = useAuth();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState(DEMO_MODE ? '' : '+53');
  const [dialCode, setDialCode] = useState<string>(DEMO_MODE ? DEMO_DIAL_CODES[0]!.code : '+53');
  const [otp, setOtp] = useState('');
  const [normalizedPhone, setNormalizedPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendTimer, setResendTimer] = useState(0);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace('/login');
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (resendTimer <= 0) return;
    const id = setInterval(() => setResendTimer((p) => (p <= 1 ? 0 : p - 1)), 1000);
    return () => clearInterval(id);
  }, [resendTimer]);

  async function handleSendCode() {
    const valid = DEMO_MODE ? isValidDemoPhone(phone) : isValidCubanPhone(phone);
    if (!valid) {
      setError(t('auth.invalid_phone', { defaultValue: 'Número de teléfono inválido' }));
      return;
    }
    const normalized = DEMO_MODE ? normalizeDemoPhone(phone, dialCode) : normalizeCubanPhone(phone);
    setNormalizedPhone(normalized);
    setLoading(true);
    setError(null);
    try {
      await authService.linkPhone(normalized);
      setStep('otp');
      setResendTimer(60);
    } catch {
      setError(t('errors.generic', { defaultValue: 'Algo salió mal. Intenta de nuevo.' }));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(codeArg?: string) {
    const code = codeArg ?? otp;
    if (code.length < 6 || loading) return;
    setLoading(true);
    setError(null);
    try {
      await authService.verifyPhoneLink(normalizedPhone, code);
      let uid = user?.id;
      if (!uid) {
        const session = await getSupabaseClient().auth.getSession();
        uid = session.data.session?.user?.id;
      }
      if (uid) {
        const updated = await authService.updateProfile(uid, { phone: normalizedPhone });
        if (!updated?.full_name) { router.push('/complete-profile'); return; }
      }
      router.push('/book');
    } catch (err) {
      // Surface the EF's stable error code (set by verifyPhoneLink): a phone
      // that already belongs to another account (typical OTP-then-Google case)
      // must NOT read as "wrong code" — point the user back to phone login.
      const c = (err as { code?: string } | null)?.code;
      setError(
        c === 'PHONE_TAKEN'
          ? t('auth.phone_taken_existing_account', { defaultValue: 'Este número ya tiene una cuenta TriciGo. Cerrá sesión e iniciá con tu teléfono.' })
          : c === 'INVALID_CODE'
            ? t('auth.invalid_otp', { defaultValue: 'Código inválido' })
            : t('errors.generic', { defaultValue: 'Algo salió mal. Intenta de nuevo.' }),
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendTimer > 0) return;
    setError(null);
    try {
      await authService.linkPhone(normalizedPhone || normalizeCubanPhone(phone));
      setResendTimer(60);
    } catch {
      setError(t('errors.generic', { defaultValue: 'Algo salió mal. Intenta de nuevo.' }));
    }
  }

  // Escape hatch — parity with the móvil SwitchAccountFooter. A user who signed
  // in with the wrong account (or whose phone already belongs to another
  // account) can sign out and start over from /login instead of being stuck.
  async function handleSwitchAccount() {
    try {
      await signOut();
    } finally {
      router.push('/login');
    }
  }

  const btnStyle = (enabled: boolean) => ({
    width: '100%', padding: '0.875rem', borderRadius: 'var(--radius-md)', border: 'none',
    background: enabled ? 'var(--primary)' : 'var(--border)', color: enabled ? 'white' : 'var(--text-tertiary)',
    fontSize: '1rem', fontWeight: 600 as const, fontFamily: 'inherit' as const,
    cursor: enabled ? 'pointer' : ('not-allowed' as const),
  });

  return (
    <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', background: 'var(--bg-page)' }}>
      <div style={{ maxWidth: 400, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--primary-alpha-10, rgba(255,77,0,0.08))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '0.75rem' }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.74-1.74a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 22 16.92z" /></svg>
          </div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>
            {step === 'phone'
              ? t('auth.verify_phone_title', { defaultValue: 'Verifica tu teléfono' })
              : t('auth.otp_title', { defaultValue: 'Ingresa el código' })}
          </h1>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem', marginTop: '0.5rem' }}>
            {step === 'phone'
              ? t('auth.verify_phone_subtitle', { defaultValue: 'Necesitamos tu número para contactarte durante el viaje y para emergencias' })
              : `${t('auth.otp_sent_to', { defaultValue: 'Enviamos un código a' })} ${normalizedPhone}`}
          </p>
        </div>

        {step === 'phone' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {DEMO_MODE ? (
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <select
                  value={dialCode}
                  onChange={(e) => setDialCode(e.target.value)}
                  className="input-base"
                  style={{ width: 'auto', fontSize: '1rem', fontWeight: 600 }}
                  aria-label={t('auth.dial_code', { defaultValue: 'Código de país' })}
                >
                  {DEMO_DIAL_CODES.map((d) => (
                    <option key={d.code} value={d.code}>{d.emoji} {d.code}</option>
                  ))}
                </select>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => { setPhone(e.target.value); setError(null); }}
                  placeholder="999999999"
                  className="input-base"
                  autoFocus
                  style={{ flex: 1, fontSize: '1.125rem', letterSpacing: '0.05em' }}
                />
              </div>
            ) : (
              <input
                type="tel"
                value={phone}
                onChange={(e) => { setPhone(e.target.value); setError(null); }}
                placeholder="+53 5XXXXXXX o 6XXXXXXX"
                className="input-base"
                autoFocus
                style={{ width: '100%', fontSize: '1.125rem', letterSpacing: '0.05em' }}
              />
            )}
            {error && <p style={{ color: 'var(--error)', fontSize: '0.875rem', textAlign: 'center' }}>{error}</p>}
            <button onClick={handleSendCode} disabled={(DEMO_MODE ? !isValidDemoPhone(phone) : !isValidCubanPhone(phone)) || loading} style={btnStyle((DEMO_MODE ? isValidDemoPhone(phone) : isValidCubanPhone(phone)) && !loading)}>
              {loading ? t('auth.sending', { defaultValue: 'Enviando...' }) : t('auth.send_code', { defaultValue: 'Enviar código' })}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <input
              type="text"
              inputMode="numeric"
              value={otp}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                setOtp(v);
                if (v.length === 6 && !loading) handleVerify(v);
              }}
              placeholder="000000"
              maxLength={6}
              autoFocus
              className="input-base"
              style={{ fontSize: '1.5rem', textAlign: 'center', letterSpacing: '0.3em' }}
            />
            {error && <p style={{ color: 'var(--error)', fontSize: '0.875rem', textAlign: 'center' }}>{error}</p>}
            <button onClick={() => handleVerify()} disabled={otp.length < 6 || loading} style={btnStyle(otp.length === 6 && !loading)}>
              {loading ? t('auth.verifying', { defaultValue: 'Verificando...' }) : t('auth.verify', { defaultValue: 'Verificar' })}
            </button>
            <button
              type="button"
              onClick={handleResend}
              disabled={resendTimer > 0}
              style={{ background: 'none', border: 'none', color: resendTimer > 0 ? 'var(--text-tertiary)' : 'var(--primary)', cursor: resendTimer > 0 ? 'default' : 'pointer', fontSize: '0.875rem' }}
            >
              {resendTimer > 0
                ? `${t('auth.resend_code', { defaultValue: 'Reenviar código' })} (${resendTimer}s)`
                : t('auth.resend_code', { defaultValue: 'Reenviar código' })}
            </button>
            <button
              type="button"
              onClick={() => { setStep('phone'); setOtp(''); setError(null); }}
              style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '0.875rem' }}
            >
              ← {t('auth.change_phone', { defaultValue: 'Cambiar número' })}
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={handleSwitchAccount}
          style={{ display: 'block', width: '100%', marginTop: '1.5rem', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.875rem', textAlign: 'center', fontFamily: 'inherit' }}
        >
          {t('auth.switch_account_prompt', { defaultValue: '¿Cuenta equivocada? Cerrar sesión' })}
        </button>
      </div>
    </main>
  );
}
