import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Politica de Reembolsos y Cancelaciones — TriciGo',
  description:
    'Conoce las condiciones de cancelacion de viajes, reembolso de creditos no consumidos y disputas en TriciGo.',
  alternates: {
    canonical: 'https://tricigo.com/refunds',
  },
  openGraph: {
    title: 'Politica de Reembolsos y Cancelaciones — TriciGo',
    description:
      'Condiciones de cancelacion de viajes, reembolso de creditos y disputas en TriciGo.',
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
        Politica de Reembolsos y Cancelaciones
      </h1>
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginBottom: '2.5rem' }}>
        Como gestionamos cancelaciones, reembolsos y disputas en TriciGo.
      </p>

      <Section title="Cancelacion de viajes">
        <p>
          Puedes cancelar tu viaje sin cargo siempre que lo hagas antes de que un conductor lo
          acepte. Si el conductor ya fue asignado y esta en camino hacia el punto de recogida,
          puede aplicar una tarifa de cancelacion. La app siempre muestra el monto de esa tarifa
          antes de que confirmes la cancelacion, para que decidas con la informacion completa.
        </p>
      </Section>

      {/* Parámetros de reembolso propuestos — confirmar con el negocio */}
      <Section title="Reembolso de creditos no consumidos">
        <p>
          Los creditos TriciCoin son un credito prepago de transporte que se usa unicamente para
          pagar viajes dentro de la app. Si decides cerrar tu cuenta, el saldo de creditos no
          consumidos puede reembolsarse al metodo de pago original con el que fueron adquiridos.
          El reembolso se procesa dentro de un plazo aproximado de 14 dias habiles a partir de la
          solicitud de cierre de cuenta.
        </p>
      </Section>

      <Section title="Disputas de viaje">
        <p>
          Si tienes un problema con un viaje (cobro incorrecto, ruta no realizada u otra
          incidencia), usa la funcion de disputa disponible en el detalle del viaje dentro de la
          app. Nuestro equipo revisa cada disputa junto con la evidencia asociada al viaje y te
          comunica la resolucion.
        </p>
      </Section>

      <Section title="Antes de un contracargo (chargeback)">
        <p>
          Si estas considerando solicitar un contracargo a tu banco o emisor de tarjeta, te
          pedimos que primero te pongas en contacto con nuestro equipo de soporte escribiendo a{' '}
          <a
            href="mailto:soporte@tricigo.com"
            style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}
          >
            soporte@tricigo.com
          </a>
          . La mayoria de los casos se resuelven de forma mas rapida y directa a traves de
          soporte que mediante un proceso de contracargo.
        </p>
      </Section>

      <Section title="Contacto">
        <p>
          Para cualquier consulta sobre reembolsos o cancelaciones, escribenos a{' '}
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
          Ir a la pagina de contacto
        </Link>
      </p>
    </main>
  );
}
