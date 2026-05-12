'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseClient, referralService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { useAuth } from '../providers';

type Step = 'phone' | 'otp';

// sessionStorage key shared with /refer/[code] so a rider who clicks
// a referral link, then signs in via OAuth (Google/Apple) round-trips
// off-page, still applies the code on return.
const PENDING_REFERRAL_KEY = 'tricigo_pending_referral';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // 'common' namespace — auth keys are shared across web/client/driver
  // so the rider sees the same OTP/login copy whichever surface they
  // sign in from. Web.docx 2026-05-08: "que el mensaje de registro se
  // aplique en todos lados".
  const { t } = useTranslation('common');
  const { isAuthenticated, isLoading } = useAuth();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('+53');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingReferralCode, setPendingReferralCode] = useState<string | null>(null);

  // Capture ?ref=CODE on mount and persist it. The query param goes
  // first; if absent, fall back to whatever was already stashed
  // (e.g. from a prior /refer/[code] visit). Codes survive an OAuth
  // round-trip because sessionStorage persists across same-origin
  // redirects within the tab.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const fromQuery = searchParams.get('ref')?.trim().toUpperCase() ?? null;
    if (fromQuery) {
      try {
        sessionStorage.setItem(PENDING_REFERRAL_KEY, fromQuery);
      } catch { /* private mode / quota — non-fatal */ }
      setPendingReferralCode(fromQuery);
      return;
    }
    try {
      setPendingReferralCode(sessionStorage.getItem(PENDING_REFERRAL_KEY));
    } catch { /* ignore */ }
  }, [searchParams]);

  // Apply a pending referral once the user has a session. Best-effort:
  // failure (invalid code, self-referral, already-applied) is logged
  // and the redirect proceeds anyway, so a bad code never blocks
  // login. The stored value is cleared either way.
  async function applyPendingReferralIfAny(uid: string) {
    let code: string | null = null;
    try {
      code = sessionStorage.getItem(PENDING_REFERRAL_KEY);
    } catch { return; }
    if (!code) return;
    try {
      await referralService.applyReferralCode(uid, code);
    } catch (err) {
      console.warn('[login] applyReferralCode failed:', err);
    } finally {
      try { sessionStorage.removeItem(PENDING_REFERRAL_KEY); } catch { /* ignore */ }
    }
  }

  // Redirect to /book if already logged in
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace('/book');
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading || isAuthenticated) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-page)' }}>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>{t('loading')}</p>
      </main>
    );
  }

  async function handleSendOtp() {
    if (phone.length < 8) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseClient();
      const { error: otpError } = await supabase.functions.invoke('send-sms-otp', {
        body: { phone },
      });
      if (otpError) throw otpError;
      setStep('otp');
    } catch (err) {
      setError(t('auth.send_otp_failed'));
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp() {
    if (otp.length < 4) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseClient();
      const { data, error: verifyError } = await supabase.functions.invoke('verify-otp', {
        body: { phone, code: otp },
      });
      if (verifyError) throw verifyError;
      if (data?.error) throw new Error(data.error);
      if (data?.session) {
        await supabase.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
        // Apply the pending referral code (if any) before routing.
        // Fire-and-forget would race with /book's data load, so we
        // await — the call is best-effort and capped at one network
        // round trip.
        const uid = data.session.user?.id;
        if (uid) await applyPendingReferralIfAny(uid);
      }
      router.push('/book');
    } catch (err) {
      setError(t('auth.invalid_otp'));
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseClient();
      const { error: googleError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          queryParams: { access_type: 'offline', prompt: 'consent' },
        },
      });
      if (googleError) throw googleError;
    } catch (err) {
      setError(t('auth.google_login_failed'));
      console.error(err);
      setLoading(false);
    }
  }

  async function handleAppleLogin() {
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseClient();
      const { error: appleError } = await supabase.auth.signInWithOAuth({
        provider: 'apple',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (appleError) throw appleError;
    } catch (err) {
      setError(t('auth.apple_login_failed'));
      console.error(err);
      setLoading(false);
    }
  }

  const btnStyle = (enabled: boolean) => ({
    width: '100%',
    padding: '0.875rem',
    borderRadius: 'var(--radius-md)',
    border: 'none',
    background: enabled ? 'var(--primary)' : 'var(--border)',
    color: enabled ? 'white' : 'var(--text-tertiary)',
    fontSize: 'var(--text-lg)',
    fontWeight: 600 as const,
    fontFamily: 'inherit' as const,
    cursor: enabled ? 'pointer' : ('not-allowed' as const),
    transition: 'all var(--transition-fast)' as const,
  });

  const socialBtnStyle = {
    width: '100%',
    padding: '0.875rem',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    fontSize: 'var(--text-md)',
    fontWeight: 500 as const,
    fontFamily: 'inherit' as const,
    cursor: 'pointer' as const,
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: '0.5rem',
    transition: 'all var(--transition-fast)' as const,
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        background: 'var(--bg-page)',
      }}
    >
      <div style={{ maxWidth: 400, width: '100%' }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h1 style={{ fontSize: '2.5rem', fontWeight: 800, margin: 0 }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </h1>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem', marginTop: '0.5rem' }}>
            {t('auth.subtitle')}
          </p>
        </div>

        {/* Social Login Buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <button onClick={handleGoogleLogin} disabled={loading} style={socialBtnStyle}>
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            {t('auth.continue_with_google')}
          </button>

          <button onClick={handleAppleLogin} disabled={loading} style={socialBtnStyle}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#000">
              <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
            </svg>
            {t('auth.continue_with_apple')}
          </button>
        </div>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          <span style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>{t('auth.or_with_phone')}</span>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        {step === 'phone' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                {t('auth.phone_label')}
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+53 5XXXXXXX"
                className="input-base"
                style={{ fontSize: '1.125rem', letterSpacing: '0.05em' }}
              />
            </div>
            <button
              onClick={handleSendOtp}
              disabled={phone.length < 8 || loading}
              style={btnStyle(phone.length >= 8 && !loading)}
            >
              {loading ? t('auth.sending') : t('auth.send_code')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* otp_sent_to is the prefix without {{phone}}; we render
                the phone as a separate <strong> sibling so the visual
                anchor (bold number) survives translation without
                pulling in the heavier Trans component. */}
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', textAlign: 'center' }}>
              {t('auth.otp_sent_to')} <strong>{phone}</strong>
            </p>
            <input
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              className="input-base"
              style={{ fontSize: '1.5rem', textAlign: 'center', letterSpacing: '0.3em' }}
            />
            <button
              onClick={handleVerifyOtp}
              disabled={otp.length < 4 || loading}
              style={btnStyle(otp.length >= 4 && !loading)}
            >
              {loading ? t('auth.verifying') : t('auth.verify')}
            </button>
            <button
              type="button"
              onClick={() => { setStep('phone'); setOtp(''); setError(null); }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--primary)',
                cursor: 'pointer',
                fontSize: '0.875rem',
                textAlign: 'center',
              }}
            >
              ← {t('auth.change_number')}
            </button>
          </div>
        )}

        {error && (
          <p style={{ color: 'var(--error)', fontSize: '0.875rem', textAlign: 'center', marginTop: '1rem' }}>
            {error}
          </p>
        )}

        <div style={{ textAlign: 'center', marginTop: '2rem' }}>
          <Link href="/" style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem', textDecoration: 'none' }}>
            ← {t('auth.back_to_home')}
          </Link>
        </div>
      </div>
    </main>
  );
}
