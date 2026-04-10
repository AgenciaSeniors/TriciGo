'use client';

export default function ChatError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>
        Trici<span style={{ color: 'var(--primary)' }}>Go</span>
      </div>
      <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>Error en el chat</h2>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: 0 }}>{error.message}</p>
      <button
        onClick={reset}
        style={{
          padding: '0.5rem 1.5rem',
          background: 'var(--primary)',
          color: '#fff',
          border: 'none',
          borderRadius: 'var(--radius-md, 8px)',
          fontSize: '0.9rem',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Reintentar
      </button>
    </div>
  );
}
