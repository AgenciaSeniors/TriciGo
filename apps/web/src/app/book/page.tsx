'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function BookPage() {
  const [pickup, setPickup] = useState('');
  const [dropoff, setDropoff] = useState('');

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: 500, width: '100%' }}>
        <Link
          href="/"
          style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}
        >
          ← Volver
        </Link>

        <h1 style={{ fontSize: '2rem', fontWeight: 800, marginTop: '1rem', marginBottom: '0.5rem' }}>
          Solicitar viaje
        </h1>
        <p style={{ color: '#888', marginBottom: '2rem' }}>
          Ingresa las direcciones para obtener una estimación de tarifa.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
              Punto de recogida
            </label>
            <input
              type="text"
              value={pickup}
              onChange={(e) => setPickup(e.target.value)}
              placeholder="¿Dónde te recogemos?"
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                borderRadius: '0.75rem',
                border: '1px solid #ddd',
                fontSize: '1rem',
                outline: 'none',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
              Destino
            </label>
            <input
              type="text"
              value={dropoff}
              onChange={(e) => setDropoff(e.target.value)}
              placeholder="¿A dónde vas?"
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                borderRadius: '0.75rem',
                border: '1px solid #ddd',
                fontSize: '1rem',
                outline: 'none',
              }}
            />
          </div>

          <button
            disabled={!pickup || !dropoff}
            style={{
              width: '100%',
              padding: '1rem',
              borderRadius: '0.75rem',
              border: 'none',
              background: pickup && dropoff ? 'var(--primary)' : '#ccc',
              color: 'white',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: pickup && dropoff ? 'pointer' : 'not-allowed',
              marginTop: '0.5rem',
            }}
          >
            Obtener estimación
          </button>
        </div>

        <p
          style={{
            marginTop: '2rem',
            padding: '1rem',
            background: '#f9f9f9',
            borderRadius: '0.75rem',
            fontSize: '0.875rem',
            color: '#888',
            textAlign: 'center',
          }}
        >
          Para una experiencia completa, descarga la app de TriciGo.
        </p>
      </div>
    </main>
  );
}
