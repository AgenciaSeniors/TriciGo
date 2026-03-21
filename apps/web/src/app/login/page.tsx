'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createBrowserClient } from '@/lib/supabase';

type Step = 'phone' | 'otp';

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('+53');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendOtp() {
    if (phone.length < 8) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      const { error: otpError } = await supabase.functions.invoke('send-sms-otp', {
        body: { phone },
      });
      if (otpError) throw otpError;
      setStep('otp');
    } catch (err) {
      setError('No se pudo enviar el código. Verifica el número.');
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
      const supabase = createBrowserClient();
      const { data, error: verifyError } = await supabase.functions.invoke('verify-whatsapp-otp', {
        body: { phone, code: otp },
      });
      if (verifyError) throw verifyError;
      if (data?.error) throw new Error(data.error);
      if (data?.session) {
        await supabase.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
      }
      router.push('/book');
    } catch (err) {
      setError('Código incorrecto. Intenta de nuevo.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    setLoading(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      const { error: googleError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/book`,
          queryParams: { access_type: 'offline', prompt: 'consent' },
        },
      });
      if (googleError) throw googleError;
    } catch (err) {
      setError('Error al iniciar con Google.');
      console.error(err);
      setLoading(false);
    }
  }

  async function handleAppleLogin() {
    setLoading(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      const { error: appleError } = await supabase.auth.signInWithOAuth({
        provider: 'apple',
        options: {
          redirectTo: `${window.location.origin}/book`,
        },
      });
      if (appleError) throw appleError;
    } catch (err) {
      setError('Error al iniciar con Apple.');
      console.error(err);
      setLoading(false);
    }
  }

  const btnStyle = (enabled: boolean) => ({
    width: '100%',
    padding: '0.875rem',
    borderRadius: '0.75rem',
    border: 'none',
    background: enabled ? 'var(--primary)' : '#e0e0e0',
    color: enabled ? 'white' : '#999',
    fontSize: '1rem',
    fontWeight: 600 as const,
    cursor: enabled ? 'pointer' : ('not-allowed' as const),
  });

  const socialBtnStyle = {
    width: '100%',
    padding: '0.875rem',
    borderRadius: '0.75rem',
    border: '1px solid #ddd',
    background: 'white',
    color: '#333',
    fontSize: '0.95rem',
    fontWeight: 500 as const,
    cursor: 'pointer' as const,
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: '0.5rem',
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
        background: '#fafafa',
      }}
    >
      <div style={{ maxWidth: 400, width: '100%' }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h1 style={{ fontSize: '2.5rem', fontWeight: 800, margin: 0 }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </h1>
          <p style={{ color: '#888', fontSize: '0.9rem', marginTop: '0.5rem' }}>
            Inicia sesión para solicitar viajes
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
            Continuar con Google
          </button>

          <button onClick={handleAppleLogin} disabled={loading} style={socialBtnStyle}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#000">
              <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
            </svg>
            Continuar con Apple
          </button>
        </div>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ flex: 1, height: 1, background: '#ddd' }} />
          <span style={{ color: '#999', fontSize: '0.8rem' }}>o con teléfono</span>
          <div style={{ flex: 1, height: 1, background: '#ddd' }} />
        </div>

        {step === 'phone' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                Número de teléfono
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+53 5XXXXXXX"
                style={{
                  width: '100%',
                  padding: '0.75rem 1rem',
                  borderRadius: '0.75rem',
                  border: '1px solid #ddd',
                  fontSize: '1.125rem',
                  outline: 'none',
                  letterSpacing: '0.05em',
                }}
              />
            </div>
            <button
              onClick={handleSendOtp}
              disabled={phone.length < 8 || loading}
              style={btnStyle(phone.length >= 8 && !loading)}
            >
              {loading ? 'Enviando...' : 'Enviar código'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ color: '#666', fontSize: '0.875rem', textAlign: 'center' }}>
              Enviamos un código a <strong>{phone}</strong>
            </p>
            <input
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                borderRadius: '0.75rem',
                border: '1px solid #ddd',
                fontSize: '1.5rem',
                outline: 'none',
                textAlign: 'center',
                letterSpacing: '0.3em',
              }}
            />
            <button
              onClick={handleVerifyOtp}
              disabled={otp.length < 4 || loading}
              style={btnStyle(otp.length >= 4 && !loading)}
            >
              {loading ? 'Verificando...' : 'Verificar'}
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
              ← Cambiar número
            </button>
          </div>
        )}

        {error && (
          <p style={{ color: '#dc2626', fontSize: '0.875rem', textAlign: 'center', marginTop: '1rem' }}>
            {error}
          </p>
        )}

        <div style={{ textAlign: 'center', marginTop: '2rem' }}>
          <Link href="/" style={{ color: '#888', fontSize: '0.8rem', textDecoration: 'none' }}>
            ← Volver al inicio
          </Link>
        </div>
      </div>
    </main>
  );
}
