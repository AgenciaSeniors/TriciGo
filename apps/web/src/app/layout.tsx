import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TriciGo — Pide tu viaje',
  description: 'Solicita un viaje en La Habana con TriciGo',
  icons: { icon: '/favicon.ico' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="font-sans antialiased bg-white text-neutral-900">
        {/* Header */}
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1rem 2rem',
            borderBottom: '1px solid #eee',
            position: 'sticky',
            top: 0,
            background: 'white',
            zIndex: 50,
          }}
        >
          <a href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 800 }}>
              Trici<span style={{ color: '#FF4D00' }}>Go</span>
            </span>
          </a>
          <nav style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
            <a
              href="/book"
              style={{
                color: '#FF4D00',
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              Solicitar viaje
            </a>
            <a
              href="/login"
              style={{
                background: '#FF4D00',
                color: 'white',
                padding: '0.5rem 1.25rem',
                borderRadius: '0.5rem',
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: '0.85rem',
              }}
            >
              Iniciar sesión
            </a>
          </nav>
        </header>

        {children}

        {/* Footer */}
        <footer
          style={{
            borderTop: '1px solid #eee',
            padding: '2rem',
            textAlign: 'center',
            color: '#999',
            fontSize: '0.8rem',
          }}
        >
          <div style={{ marginBottom: '0.75rem' }}>
            <span style={{ fontWeight: 700, color: '#111' }}>
              Trici<span style={{ color: '#FF4D00' }}>Go</span>
            </span>
            {' · '}La Habana, Cuba
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '1.5rem', marginBottom: '0.75rem' }}>
            <a href="/book" style={{ color: '#666', textDecoration: 'none', fontSize: '0.8rem' }}>
              Solicitar viaje
            </a>
            <a href="/login" style={{ color: '#666', textDecoration: 'none', fontSize: '0.8rem' }}>
              Iniciar sesión
            </a>
          </div>
          <p>TriciGo © {new Date().getFullYear()} · Descarga la app para la experiencia completa</p>
        </footer>
      </body>
    </html>
  );
}
