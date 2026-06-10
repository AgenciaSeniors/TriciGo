import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Política de Prestación del Servicio — TriciGo',
  description:
    'Cómo y cuándo se presta el servicio TriciGo: viajes y mensajería bajo demanda, y acreditación inmediata de recargas TriciCoin.',
  alternates: {
    canonical: 'https://tricigo.com/delivery-policy',
  },
  openGraph: {
    title: 'Política de Prestación del Servicio — TriciGo',
    description:
      'Cómo y cuándo se presta el servicio TriciGo: viajes, mensajería y recargas TriciCoin.',
    url: 'https://tricigo.com/delivery-policy',
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

export default function DeliveryPolicyPage() {
  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
        Política de Prestación del Servicio
      </h1>
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
        Cómo y cuándo se presta cada servicio que contratas en TriciGo.
      </p>
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem', marginBottom: '2.5rem' }}>
        Última actualización: 10 de junio de 2026
      </p>

      <Section title="Qué entregamos">
        <p>
          TriciGo es una plataforma de movilidad urbana. No vendemos bienes
          físicos que se envíen por correo: los &ldquo;productos&rdquo; que contratas son
          (a) <strong>servicios de transporte y mensajería bajo demanda</strong> prestados
          por conductores independientes en Cuba, y (b) <strong>crédito digital
          TriciCoin</strong> que recargas en tu billetera para pagar esos servicios.
        </p>
      </Section>

      <Section title="Recargas TriciCoin (entrega digital inmediata)">
        <p>
          Cuando recargas TriciCoin con tarjeta, el crédito se acredita en tu
          billetera <strong>de forma automática e inmediata</strong> en cuanto el
          procesador de pagos confirma la transacción — normalmente en menos de
          un minuto. Verás el saldo actualizado en la app y recibirás un
          comprobante por correo electrónico.
        </p>
        <p style={{ marginTop: '0.5rem' }}>
          Si el pago fue confirmado y el crédito no aparece en 24 horas,
          escríbenos (ver &ldquo;Contacto&rdquo; abajo) indicando la fecha y el monto:
          lo investigamos y acreditamos manualmente si corresponde. Las
          devoluciones de recargas se rigen por nuestra{' '}
          <Link href="/refunds" style={{ color: 'var(--primary)' }}>Política de Reembolsos</Link>.
        </p>
      </Section>

      <Section title="Viajes (servicio bajo demanda)">
        <p>
          Los viajes se prestan en el momento en que los solicitas, sujetos a la
          disponibilidad de conductores en tu zona. La app te muestra antes de
          confirmar: la tarifa estimada, el tipo de vehículo y el tiempo
          aproximado de llegada. El servicio se considera entregado cuando el
          viaje finaliza en el destino acordado; recibirás el recibo con el
          desglose final por correo y en la app.
        </p>
        <p style={{ marginTop: '0.5rem' }}>
          Si no hay conductores disponibles, la solicitud se cancela sin costo.
          Las cancelaciones de viajes ya aceptados se rigen por la política de
          cancelación descrita en nuestros{' '}
          <Link href="/terms" style={{ color: 'var(--primary)' }}>Términos y Condiciones</Link>.
        </p>
      </Section>

      <Section title="Mensajería (entrega de paquetes)">
        <p>
          El servicio de mensajería recoge y entrega tu paquete dentro de la
          misma ciudad, normalmente <strong>en el mismo día y en el curso de la
          misma solicitud</strong> (no es un servicio de paquetería con plazos de
          días). El destinatario confirma la recepción con un código de
          verificación y el conductor registra una foto de la entrega, que queda
          disponible como comprobante.
        </p>
      </Section>

      <Section title="Cobertura geográfica">
        <p>
          El servicio opera en Cuba. La disponibilidad concreta depende de los
          conductores activos en cada municipio; la app te indica si tu zona
          tiene cobertura en este momento.
        </p>
      </Section>

      <Section title="Contacto">
        <p>
          Para cualquier incidencia con la prestación del servicio:{' '}
          <a href="mailto:soporte@tricigo.com" style={{ color: 'var(--primary)' }}>
            soporte@tricigo.com
          </a>{' '}
          o desde la sección Ayuda de la app. Datos completos de la empresa en{' '}
          <Link href="/contact" style={{ color: 'var(--primary)' }}>Contacto</Link>.
        </p>
      </Section>
    </main>
  );
}
