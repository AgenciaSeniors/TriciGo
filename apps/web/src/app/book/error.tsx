'use client';

import { useEffect } from 'react';

export default function BookError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Book] Unhandled error:', error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        textAlign: 'center',
        fontFamily: 'Montserrat, system-ui, sans-serif',
      }}
    >
      <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🚧</div>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>
        Error al cargar la reserva
      </h2>
      <p style={{ color: '#666', marginBottom: '1.5rem', fontSize: '0.875rem', maxWidth: 400 }}>
        Hubo un problema cargando esta página. Intenta recargar para obtener la versión más reciente.
      </p>
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button
          onClick={() => window.location.reload()}
          style={{
            background: '#FF4D00',
            color: 'white',
            border: 'none',
            padding: '0.65rem 1.5rem',
            borderRadius: '0.5rem',
            fontSize: '0.875rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Recargar página
        </button>
        <button
          onClick={reset}
          style={{
            background: 'transparent',
            color: '#FF4D00',
            border: '2px solid #FF4D00',
            padding: '0.65rem 1.5rem',
            borderRadius: '0.5rem',
            fontSize: '0.875rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reintentar
        </button>
      </div>
    </div>
  );
}
