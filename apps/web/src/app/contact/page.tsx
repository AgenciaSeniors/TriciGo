import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Contacto — TriciGo',
  description:
    'Ponte en contacto con el equipo de TriciGo. Correo de soporte y datos del operador del servicio.',
  alternates: {
    canonical: 'https://tricigo.com/contact',
  },
  openGraph: {
    title: 'Contacto — TriciGo',
    description: 'Ponte en contacto con el equipo de TriciGo.',
    url: 'https://tricigo.com/contact',
  },
};

const CONTACT_PHONE = '+5545998622511';

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

export default function ContactPage() {
  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
        Contacto
      </h1>
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginBottom: '2.5rem' }}>
        Estamos disponibles para ayudarte con cualquier consulta sobre TriciGo.
      </p>

      <Section title="Correo de soporte">
        <p>
          Para dudas, incidencias o solicitudes, escribenos a{' '}
          <a
            href="mailto:soporte@tricigo.com"
            style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}
          >
            soporte@tricigo.com
          </a>
          . Nuestro equipo de soporte revisa cada mensaje y te respondera lo antes posible.
        </p>
      </Section>

      {CONTACT_PHONE && (
        <Section title="Telefono">
          <p>
            Tambien puedes comunicarte con nosotros por telefono al{' '}
            <a
              href={`tel:${CONTACT_PHONE}`}
              style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}
            >
              {CONTACT_PHONE}
            </a>
            .
          </p>
        </Section>
      )}

      <Section title="Datos del operador">
        <p>
          TriciGo es un servicio operado por MACH DIGITAL TECH S.R.L.
        </p>
        <p style={{ marginTop: '0.75rem', color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>
          CUI 54552055
          <br />
          Nr. Reg. Com. J2026027319006
          <br />
          Str. Lungă nr. 149, Ap. P3, Brașov, Rumanía
        </p>
      </Section>
    </main>
  );
}
