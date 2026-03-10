'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authService } from '@tricigo/api';

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
      await authService.sendOTP(phone);
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
      await authService.verifyOTP(phone, otp);
      router.push('/book');
    } catch (err) {
      setError('Código incorrecto. Intenta de nuevo.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: 400, width: '100%' }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h1 style={{ fontSize: '2.5rem', fontWeight: 800 }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </h1>
          <p style={{ color: '#888', fontSize: '0.9rem' }}>Inicia sesión para solicitar viajes</p>
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
              style={{
                width: '100%',
                padding: '1rem',
                borderRadius: '0.75rem',
                border: 'none',
                background: phone.length >= 8 && !loading ? 'var(--primary)' : '#ccc',
                color: 'white',
                fontSize: '1rem',
                fontWeight: 600,
                cursor: phone.length >= 8 && !loading ? 'pointer' : 'not-allowed',
              }}
            >
              {loading ? 'Enviando...' : 'Enviar código'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ color: '#666', fontSize: '0.875rem', textAlign: 'center' }}>
              Enviamos un código a <strong>{phone}</strong>
            </p>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                Código de verificación
              </label>
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
            </div>

            <button
              onClick={handleVerifyOtp}
              disabled={otp.length < 4 || loading}
              style={{
                width: '100%',
                padding: '1rem',
                borderRadius: '0.75rem',
                border: 'none',
                background: otp.length >= 4 && !loading ? 'var(--primary)' : '#ccc',
                color: 'white',
                fontSize: '1rem',
                fontWeight: 600,
                cursor: otp.length >= 4 && !loading ? 'pointer' : 'not-allowed',
              }}
            >
              {loading ? 'Verificando...' : 'Verificar'}
            </button>

            <button
              type="button"
              onClick={() => {
                setStep('phone');
                setOtp('');
                setError(null);
              }}
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
          <p style={{ color: '#e04400', fontSize: '0.875rem', textAlign: 'center', marginTop: '1rem' }}>
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
