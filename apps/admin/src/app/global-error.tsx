'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
          <h1 style={{ fontSize: '3rem', fontWeight: 800, color: '#171717' }}>Error</h1>
          <p style={{ marginTop: '1rem', fontSize: '1.125rem', color: '#525252' }}>Algo salio mal</p>
          <button
            onClick={() => reset()}
            style={{ marginTop: '2rem', padding: '0.75rem 1.5rem', background: '#171717', color: 'white', borderRadius: '0.5rem', border: 'none', cursor: 'pointer' }}
          >
            Intentar de nuevo
          </button>
        </div>
      </body>
    </html>
  );
}
