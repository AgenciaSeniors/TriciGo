import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Política de Prevención de Lavado de Dinero (AML) — TriciGo',
  description:
    'Política AML y de uso aceptable de TriciGo: límites de recarga, monitoreo de fraude y derechos reservados de la plataforma.',
  alternates: {
    canonical: 'https://tricigo.com/aml',
  },
  openGraph: {
    title: 'Política AML y de Uso Aceptable — TriciGo',
    description:
      'Política de prevención de lavado de dinero y uso aceptable de los créditos TriciCoin.',
    url: 'https://tricigo.com/aml',
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

export default function AmlPage() {
  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
        Política de Prevención de Lavado de Dinero y Uso Aceptable
      </h1>
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginBottom: '2.5rem' }}>
        Cómo TriciGo previene el uso indebido de la plataforma y de los créditos de viaje.
      </p>

      <Section title="Compromiso con la prevención del lavado de dinero">
        <p>
          TriciGo es un servicio operado por MACH DIGITAL TECH S.R.L., sociedad
          constituida en Rumanía. La empresa opera conforme a la normativa rumana de
          prevención del lavado de dinero y la financiación del terrorismo
          (Ley 129/2019) y al marco AML de la Unión Europea. Esta política describe
          las reglas de uso aceptable de la plataforma y las medidas que aplicamos
          para prevenir el fraude y el uso indebido.
        </p>
      </Section>

      <Section title="Uso aceptable de los créditos TriciCoin">
        <p>
          Los créditos TriciCoin son un crédito de viaje prepago de uso interno
          (closed-loop): solo pueden utilizarse para pagar viajes dentro de la
          plataforma TriciGo. No son dinero, no son transferibles a otros usuarios
          ni convertibles a efectivo. Está prohibido usar la plataforma o los
          créditos para cualquier fin distinto del transporte —en particular, para
          mover, ocultar o transferir valor entre personas.
        </p>
      </Section>

      <Section title="Límites de recarga">
        <p>
          Cada recarga de créditos está sujeta a un monto mínimo y máximo por
          operación (actualmente entre 20 y 500 USD). Además, las recargas están
          sujetas a límites de frecuencia y de volumen acumulado por usuario en
          ventanas de tiempo definidas. Estos límites pueden ajustarse y variar
          según el resultado de nuestros controles de riesgo.
        </p>
      </Section>

      <Section title="Monitoreo y prevención de fraude">
        <p>
          Monitoreamos la actividad de recarga y de uso de la plataforma para
          detectar patrones anómalos o indicios de fraude. El procesamiento de los
          pagos con tarjeta se realiza a través de un proveedor certificado bajo el
          estándar PCI-DSS; TriciGo no almacena datos de tarjetas en sus sistemas.
        </p>
      </Section>

      <Section title="Derechos reservados">
        <p>
          Ante cualquier indicio de uso indebido, fraude o incumplimiento de esta
          política, TriciGo se reserva el derecho de solicitar verificación de
          identidad adicional, limitar o rechazar una recarga u operación, y
          suspender o cerrar la cuenta involucrada. También colaboramos con las
          autoridades competentes cuando la ley lo requiere.
        </p>
      </Section>

      <Section title="Contacto">
        <p>
          Para consultas sobre esta política, escríbenos a{' '}
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
        <Link href="/terms" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          Ver los Términos y Condiciones
        </Link>
      </p>
    </main>
  );
}
