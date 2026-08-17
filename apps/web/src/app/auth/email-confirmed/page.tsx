'use client';

// Página de aterrizaje del link de verificación de correo (auditoría PR #960).
// Antes NO EXISTÍA: el correo de verificación redirigía acá y el usuario caía
// en un 404. Canjea el token de un solo uso contra la EF confirm-email, que
// estampa users.email_verified_at — el gate del login por correo y del reset de
// contraseña. Deliberadamente NO inicia sesión: el click solo prueba el buzón.

import { useEffect, useRef, useState } from 'react';
import { getSupabaseClient } from '@tricigo/api';

type Status = 'verifying' | 'success' | 'error';

export default function EmailConfirmedPage() {
  const [status, setStatus] = useState<Status>('verifying');
  const [email, setEmail] = useState('');
  // React 18 StrictMode monta dos veces en dev; el token es de UN solo uso, así
  // que el segundo disparo canjearía un token ya gastado y mostraría error.
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    if (!/^[0-9a-f]{64}$/.test(token)) {
      setStatus('error');
      return;
    }

    (async () => {
      try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase.functions.invoke('confirm-email', {
          body: { token },
        });
        if (error || data?.success !== true) {
          setStatus('error');
          return;
        }
        setEmail(typeof data.email === 'string' ? data.email : '');
        setStatus('success');
      } catch {
        setStatus('error');
      }
    })();
  }, []);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg, #0a0a0a)',
        color: 'var(--text, #f5f5f5)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        {status === 'verifying' && (
          <>
            <div style={{ fontSize: 44, marginBottom: 16 }}>⏳</div>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Confirmando tu correo…</h1>
          </>
        )}
        {status === 'success' && (
          <>
            <div style={{ fontSize: 44, marginBottom: 16 }}>✅</div>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Correo confirmado</h1>
            <p style={{ opacity: 0.8, lineHeight: 1.5 }}>
              {email ? `${email} quedó verificado. ` : ''}
              Ya podés usarlo para entrar a TriciGo cuando no te lleguen los códigos por SMS.
              Podés cerrar esta página.
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <div style={{ fontSize: 44, marginBottom: 16 }}>⚠️</div>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>No pudimos confirmar el correo</h1>
            <p style={{ opacity: 0.8, lineHeight: 1.5 }}>
              El enlace venció, ya se usó, o no es válido. Pedí uno nuevo guardando tu correo
              otra vez desde tu perfil en la app.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
