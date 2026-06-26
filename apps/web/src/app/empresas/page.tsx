// ============================================================
// TriciGo — Landing pública B2B "/empresas" (PR-CORP-5, Gap 8)
//
// Marketing/SEO page to onboard Cuban businesses to TriciGo's
// corporate mobility offering. Visible in the web footer + sitemap.
// CTA goes to /empresas/registro (form, requires login).
//
// Style mirrors /refunds and /terms — single-column max-width 800px,
// no fancy components. Spanish copy, neutral and professional.
// ============================================================

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'TriciGo Empresas — Movilidad corporativa',
  description:
    'Solución de movilidad para empresas: recarga vía NETOPIA, control de presupuesto, flotas exclusivas, reportes por empleado y facturas mensuales. Solicita tu cuenta corporativa.',
  alternates: {
    canonical: 'https://tricigo.com/empresas',
  },
  openGraph: {
    title: 'TriciGo Empresas — Movilidad corporativa',
    description:
      'Cuenta corporativa B2B con flotas, control de presupuesto y reportes mensuales.',
    url: 'https://tricigo.com/empresas',
  },
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: '2.5rem' }}>
      <h2
        style={{
          fontSize: '1.35rem',
          fontWeight: 700,
          marginBottom: '0.75rem',
          color: 'var(--text-primary)',
        }}
      >
        {title}
      </h2>
      <div
        style={{
          color: 'var(--text-secondary)',
          lineHeight: 1.7,
          fontSize: '0.95rem',
        }}
      >
        {children}
      </div>
    </section>
  );
}

function FeatureCard({
  emoji,
  title,
  description,
}: {
  emoji: string;
  title: string;
  description: string;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-light)',
        borderRadius: '0.75rem',
        padding: '1.25rem',
      }}
    >
      <div style={{ fontSize: '1.6rem', marginBottom: '0.5rem' }}>{emoji}</div>
      <h3
        style={{
          fontSize: '1rem',
          fontWeight: 700,
          marginBottom: '0.4rem',
          color: 'var(--text-primary)',
        }}
      >
        {title}
      </h3>
      <p
        style={{
          margin: 0,
          fontSize: '0.85rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
        }}
      >
        {description}
      </p>
    </div>
  );
}

export default function EmpresasPage() {
  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1.5rem' }}>
      {/* Hero */}
      <h1
        style={{
          fontSize: '2.25rem',
          fontWeight: 800,
          marginBottom: '0.75rem',
          color: 'var(--text-primary)',
          lineHeight: 1.2,
        }}
      >
        Movilidad corporativa para tu empresa
      </h1>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: '1.05rem',
          lineHeight: 1.6,
          marginBottom: '2rem',
        }}
      >
        TriciGo te ofrece una solución B2B con cobertura ciudad por ciudad:
        recarga sencilla vía NETOPIA, control de presupuesto mensual, flotas
        exclusivas, reportes por empleado y facturas mensuales en PDF.
      </p>

      {/* Primary CTA */}
      <Link
        href="/empresas/registro"
        style={{
          display: 'inline-block',
          padding: '0.85rem 1.75rem',
          background: 'var(--primary)',
          color: '#fff',
          borderRadius: '0.75rem',
          fontSize: '0.95rem',
          fontWeight: 700,
          textDecoration: 'none',
          marginBottom: '3rem',
        }}
      >
        Solicitar mi cuenta corporativa
      </Link>

      {/* Features grid */}
      <Section title="Por que TriciGo Empresas">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '0.85rem',
            marginTop: '1rem',
          }}
        >
          <FeatureCard
            emoji="💳"
            title="Recarga via NETOPIA"
            description="Carga tu billetera corporativa con tarjeta (USD). $100 a $10,000 por recarga."
          />
          <FeatureCard
            emoji="📊"
            title="Control de presupuesto"
            description="Define el limite mensual, el tope por viaje y los horarios permitidos."
          />
          <FeatureCard
            emoji="🚖"
            title="Flota exclusiva (opcional)"
            description="Si tu empresa tiene flota propia, los viajes corporativos van solo a esos conductores."
          />
          <FeatureCard
            emoji="👥"
            title="Empleados ilimitados"
            description="Agrega a todos tus empleados como pasajeros con role de admin o employee."
          />
          <FeatureCard
            emoji="📄"
            title="Facturas mensuales PDF"
            description="Descarga la factura mes a mes con desglose por empleado y servicio."
          />
          <FeatureCard
            emoji="🏷️"
            title="Comision reducida"
            description="Para empresas calificadas, comision de plataforma reducida (descuento al pasajero)."
          />
        </div>
      </Section>

      <Section title="Para que tipo de empresa">
        <p>
          TriciGo Empresas funciona para hoteles que mueven personal, agencias
          de turismo que llevan clientes a excursiones, restaurantes y bares
          que necesitan traslado de equipo nocturno, hospitales y clinicas que
          coordinan visitas medicas, oficinas que ofrecen movilidad a su
          plantilla, y operadores logisticos que necesitan envios programados.
        </p>
      </Section>

      <Section title="Como funciona">
        <ol style={{ paddingLeft: '1.25rem', margin: 0 }}>
          <li style={{ marginBottom: '0.5rem' }}>
            <strong>Solicitas tu cuenta</strong> llenando el{' '}
            <Link
              href="/empresas/registro"
              style={{ color: 'var(--primary)' }}
            >
              formulario de registro
            </Link>
            . Necesitas tener una cuenta de cliente TriciGo (o crearla).
          </li>
          <li style={{ marginBottom: '0.5rem' }}>
            <strong>Te aprobamos</strong> en menos de 24 horas habiles
            (revisamos sector, tamaño y caso de uso).
          </li>
          <li style={{ marginBottom: '0.5rem' }}>
            <strong>Recargas tu billetera</strong> via NETOPIA desde el panel
            corporativo del cliente o desde la web.
          </li>
          <li style={{ marginBottom: '0.5rem' }}>
            <strong>Agregas empleados</strong> (puede ser via auto-registro
            con tu codigo o desde el admin).
          </li>
          <li>
            <strong>Tus empleados viajan</strong> seleccionando "Corporativo"
            como metodo de pago. El costo se descuenta de tu billetera y
            recibes la factura al fin de mes.
          </li>
        </ol>
      </Section>

      <Section title="Preguntas frecuentes">
        <h3
          style={{
            fontSize: '0.95rem',
            fontWeight: 700,
            color: 'var(--text-primary)',
            marginTop: '0.5rem',
            marginBottom: '0.3rem',
          }}
        >
          ¿Que tipos de servicio puedo restringir?
        </h3>
        <p>
          Triciclo, moto, auto, confort y mensajeria. Defines en el panel
          cuales estan habilitados para tu cuenta.
        </p>

        <h3
          style={{
            fontSize: '0.95rem',
            fontWeight: 700,
            color: 'var(--text-primary)',
            marginTop: '1rem',
            marginBottom: '0.3rem',
          }}
        >
          ¿Cobran un fee mensual?
        </h3>
        <p>
          No. Solo pagas por los viajes que tu empresa consume. Sin
          mensualidad ni minimos.
        </p>

        <h3
          style={{
            fontSize: '0.95rem',
            fontWeight: 700,
            color: 'var(--text-primary)',
            marginTop: '1rem',
            marginBottom: '0.3rem',
          }}
        >
          ¿Que pasa con el saldo no consumido?
        </h3>
        <p>
          Tu saldo no expira. Se acumula entre meses y puedes pedir reembolso
          en cualquier momento via el panel de admin.
        </p>

        <h3
          style={{
            fontSize: '0.95rem',
            fontWeight: 700,
            color: 'var(--text-primary)',
            marginTop: '1rem',
            marginBottom: '0.3rem',
          }}
        >
          ¿Puedo tener mi propia flota de conductores?
        </h3>
        <p>
          Si tu empresa quiere convertirse en operador de flota, contactanos a{' '}
          <Link href="/contact" style={{ color: 'var(--primary)' }}>
            soporte
          </Link>{' '}
          y evaluamos el caso. Una vez aprobada como{' '}
          <em>fleet_owner</em>, los viajes corporativos van exclusivamente a
          tus conductores.
        </p>
      </Section>

      {/* Secondary CTA */}
      <div
        style={{
          marginTop: '3rem',
          padding: '2rem',
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          textAlign: 'center',
        }}
      >
        <h2
          style={{
            fontSize: '1.2rem',
            fontWeight: 700,
            marginBottom: '0.5rem',
            color: 'var(--text-primary)',
          }}
        >
          ¿Listo para empezar?
        </h2>
        <p
          style={{
            color: 'var(--text-secondary)',
            marginBottom: '1.25rem',
            fontSize: '0.95rem',
          }}
        >
          Te respondemos en menos de 24 horas habiles.
        </p>
        <Link
          href="/empresas/registro"
          style={{
            display: 'inline-block',
            padding: '0.85rem 1.75rem',
            background: 'var(--primary)',
            color: '#fff',
            borderRadius: '0.75rem',
            fontSize: '0.95rem',
            fontWeight: 700,
            textDecoration: 'none',
          }}
        >
          Solicitar mi cuenta corporativa
        </Link>
      </div>
    </main>
  );
}
