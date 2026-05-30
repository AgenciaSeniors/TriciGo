import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Política de Reembolsos y Cancelaciones — TriciGo',
  description:
    'Conoce las condiciones de cancelación de viajes, reembolso de créditos no consumidos y disputas en TriciGo.',
  alternates: {
    canonical: 'https://tricigo.com/refunds',
  },
  openGraph: {
    title: 'Política de Reembolsos y Cancelaciones — TriciGo',
    description:
      'Condiciones de cancelación de viajes, reembolso de créditos y disputas en TriciGo.',
    url: 'https://tricigo.com/refunds',
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

export default function RefundsPage() {
  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
        Política de Reembolsos y Cancelaciones
      </h1>
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
        Cómo gestionamos cancelaciones, reembolsos y disputas en TriciGo.
      </p>
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginBottom: '2.5rem' }}>
        Última actualización: 30 de mayo de 2026
      </p>

      <Section title="Cancelación de viajes">
        <p>
          Puedes cancelar tu viaje sin cargo siempre que lo hagas antes de que un conductor lo
          acepte. Si el conductor ya fue asignado y está en camino hacia el punto de recogida,
          puede aplicar una tarifa de cancelación. La app siempre muestra el monto de esa tarifa
          antes de que confirmes la cancelación, para que decidas con la información completa.
        </p>
      </Section>

      <Section title="Créditos TriciCoin: no reembolsables">
        <p>
          Los créditos TriciCoin —tanto los del pasajero como los del conductor— son un crédito
          prepago de transporte de uso interno (closed-loop). No son reembolsables: una vez
          adquiridos no se devuelven al método de pago, ni en efectivo, ni al cierre de la cuenta.
          Tampoco se pueden transferir a otros usuarios ni convertir a dinero. Se usan
          exclusivamente para pagar viajes —en el caso del pasajero— o comisiones de plataforma
          —en el caso del conductor— dentro de TriciGo.
        </p>
      </Section>

      <Section title="Disputas de viaje">
        <p>
          Si tienes un problema con un viaje (cobro incorrecto, ruta no realizada u otra
          incidencia), usa la función de disputa disponible en el detalle del viaje dentro de la
          app. Nuestro equipo revisa cada disputa junto con la evidencia asociada al viaje y te
          comunica la resolución.
        </p>
      </Section>

      <Section title="Antes de un contracargo (chargeback)">
        <p>
          Si estás considerando solicitar un contracargo a tu banco o emisor de tarjeta, te
          pedimos que primero te pongas en contacto con nuestro equipo de soporte escribiendo a{' '}
          <a
            href="mailto:soporte@tricigo.com"
            style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}
          >
            soporte@tricigo.com
          </a>
          . La mayoría de los casos se resuelven de forma más rápida y directa a través de
          soporte que mediante un proceso de contracargo.
        </p>
      </Section>

      <Section title="Contacto">
        <p>
          Para cualquier consulta sobre reembolsos o cancelaciones, escríbenos a{' '}
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
        <Link href="/contact" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          Ir a la página de contacto
        </Link>
      </p>
    </main>
  );
}
