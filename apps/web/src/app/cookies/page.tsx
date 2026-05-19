import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Política de Cookies — TriciGo',
  description:
    'Qué cookies y tecnologías de almacenamiento usa TriciGo, para qué, y cómo controlarlas.',
  alternates: {
    canonical: 'https://tricigo.com/cookies',
  },
  openGraph: {
    title: 'Política de Cookies — TriciGo',
    description: 'Qué cookies usa TriciGo y cómo controlarlas.',
    url: 'https://tricigo.com/cookies',
  },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>
        {title}
      </h2>
      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7, fontSize: '0.95rem' }}>
        {children}
      </div>
    </section>
  );
}

export default function CookiesPage() {
  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
        Política de Cookies
      </h1>
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginBottom: '2.5rem' }}>
        Qué cookies y tecnologías de almacenamiento usamos, y cómo controlarlas.
      </p>

      <Section title="Qué son las cookies">
        <p>
          Las cookies y tecnologías similares (como el almacenamiento local del
          navegador) son pequeños archivos de datos que un sitio web guarda en tu
          dispositivo. Sirven para que el sitio funcione, para recordarte entre
          visitas y para entender de forma agregada cómo se usa el servicio.
        </p>
      </Section>

      <Section title="Cookies que usamos">
        <p>Usamos cookies y almacenamiento en dos categorías:</p>
        <ul style={{ paddingLeft: '1.25rem', marginTop: '0.5rem' }}>
          <li>
            <strong>Esenciales.</strong> Necesarias para que el sitio funcione:
            mantener tu sesión iniciada, recordar tu idioma y garantizar la
            seguridad. Sin estas el servicio no funciona, por lo que no se pueden
            desactivar.
          </li>
          <li style={{ marginTop: '0.5rem' }}>
            <strong>Analítica y rendimiento.</strong> Nos ayudan a entender de forma
            agregada cómo se usa la plataforma y a detectar errores, para mejorar el
            servicio. Para esto usamos PostHog (analítica de producto) y Sentry
            (registro de errores).
          </li>
        </ul>
      </Section>

      <Section title="Cómo controlar las cookies">
        <p>
          Puedes controlar o eliminar las cookies desde la configuración de tu
          navegador, y configurarlo para que las bloquee. Ten en cuenta que si
          bloqueas las cookies esenciales algunas partes del sitio pueden dejar de
          funcionar correctamente.
        </p>
      </Section>

      <Section title="Cambios en esta política">
        <p>
          Podemos actualizar esta Política de Cookies ocasionalmente. Publicaremos
          aquí cualquier cambio significativo.
        </p>
      </Section>

      <Section title="Contacto">
        <p>
          Para consultas sobre esta política o sobre el tratamiento de tus datos,
          escríbenos a{' '}
          <a
            href="mailto:soporte@tricigo.com"
            style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}
          >
            soporte@tricigo.com
          </a>
          .
        </p>
      </Section>

      <p style={{ marginTop: '2.5rem', fontSize: '0.85rem' }}>
        <Link href="/privacy" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          Ver la Política de Privacidad
        </Link>
      </p>
    </main>
  );
}
