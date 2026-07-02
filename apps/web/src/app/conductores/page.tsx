// Driver-acquisition landing (marketing audit 2026-07-02, PR-MKT-6).
// Server-rendered + indexed. Copy stays REGION-NEUTRAL (like the home's
// "Para conductores" bento) — the /transporte subtree is noindexed to keep
// the public surface region-neutral, and this page follows the same rule
// by never naming a country. Supports ?ref=CODE referral capture via the
// <ReferralCapture /> client child.

import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { JsonLd } from '@/components/JsonLd';
import { ReferralCapture } from './ReferralCapture';

const SITE = 'https://tricigo.com';
const PLAY_DRIVER = 'https://play.google.com/store/apps/details?id=app.tricigo.driver';
const APPSTORE_DRIVER = 'https://apps.apple.com/app/id6785157051';

export const metadata: Metadata = {
  title: 'Hazte conductor de TriciGo — Genera ingresos con tu vehículo',
  description:
    'Maneja con TriciGo: triciclo, moto o auto. Horarios flexibles, precio claro por viaje y cobros sin regateo. Regístrate gratis y empieza a ganar.',
  alternates: { canonical: `${SITE}/conductores` },
  openGraph: {
    title: 'Hazte conductor de TriciGo',
    description:
      'Convierte tu vehículo en una fuente de ingreso. Tú eliges cuándo manejar y qué viajes aceptar.',
    url: `${SITE}/conductores`,
  },
};

const STEPS = [
  {
    title: 'Descarga TriciGo Conductor',
    body: 'Disponible para Android y iOS. Crea tu cuenta con tu número de teléfono en menos de un minuto.',
  },
  {
    title: 'Completa tu registro',
    body: 'Datos personales, tu vehículo (triciclo, moto o auto) y fotos de tus documentos: identidad, licencia de conducción y registro del vehículo.',
  },
  {
    title: 'Te verificamos rápido',
    body: 'Nuestro equipo revisa tu solicitud — el tiempo promedio es de 24 horas hábiles. Te avisamos por notificación y correo.',
  },
  {
    title: 'Conéctate y gana',
    body: 'Ponte online cuando quieras. Ves el precio y la ruta de cada viaje antes de aceptar — tú decides cuáles te convienen.',
  },
];

const BENEFITS = [
  {
    title: 'Tú pones el horario',
    body: 'Sin turnos ni jefes. Conéctate una hora o todo el día; la app trabaja cuando tú trabajas.',
  },
  {
    title: 'Precio claro, sin regateo',
    body: 'Cada viaje muestra la tarifa antes de aceptar. El pasajero ya sabe cuánto paga — tú ya sabes cuánto ganas.',
  },
  {
    title: 'Cobra en efectivo o saldo',
    body: 'Acepta viajes en efectivo o con créditos de viaje. Tus ganancias quedan registradas en tu billetera dentro de la app.',
  },
  {
    title: 'Viajes cerca de ti',
    body: 'El mapa de demanda te muestra dónde hay más pasajeros para que no manejes vacío.',
  },
];

const FAQ = [
  {
    q: '¿Qué necesito para registrarme?',
    a: 'Documento de identidad, licencia de conducción vigente, el registro de tu vehículo y una foto del vehículo. Todo se sube desde la app en el registro.',
  },
  {
    q: '¿Qué vehículos aceptan?',
    a: 'Triciclos de pasajeros, motos y autos. También hay servicio de mensajería para paquetes.',
  },
  {
    q: '¿Cuánto demora la aprobación?',
    a: 'El tiempo promedio de revisión es de 24 horas hábiles. Te avisamos apenas tu cuenta quede aprobada.',
  },
  {
    q: '¿Tiene costo registrarse?',
    a: 'No. Registrarse es gratis. La plataforma cobra una comisión por viaje completado, que ves desglosada en cada viaje.',
  },
  {
    q: 'Me invitó otro conductor, ¿qué hago con su código?',
    a: 'Ingrésalo en el paso de datos personales del registro (o en Perfil → Referidos antes de que aprueben tu cuenta). Así quien te invitó recibe su bono.',
  },
];

export default function ConductoresPage() {
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'Conductores', item: `${SITE}/conductores` },
    ],
  };

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <JsonLd data={breadcrumbJsonLd} />
      <JsonLd data={faqJsonLd} />

      <nav aria-label="Migas" style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '1.25rem' }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Inicio</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <span style={{ color: 'var(--text-secondary)' }}>Conductores</span>
      </nav>

      {/* ?ref=CODE banner + sessionStorage stash (client-side only) */}
      <Suspense fallback={null}>
        <ReferralCapture />
      </Suspense>

      <h1 style={{ fontSize: '2.25rem', fontWeight: 800, lineHeight: 1.2, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>
        Genera ingresos con tu vehículo
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.75rem' }}>
        Maneja con TriciGo cuando quieras: triciclo, moto o auto. Precio claro por viaje,
        sin regateo en la calle, y tú decides qué viajes aceptar. Registrarse es gratis.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '3rem' }}>
        <a
          href={PLAY_DRIVER}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block', padding: '0.85rem 1.4rem', borderRadius: '0.75rem',
            background: 'var(--primary)', color: '#fff', fontWeight: 700, fontSize: '0.95rem',
            textDecoration: 'none',
          }}
        >
          Descargar en Google Play
        </a>
        <a
          href={APPSTORE_DRIVER}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block', padding: '0.85rem 1.4rem', borderRadius: '0.75rem',
            background: 'var(--bg-card)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '0.95rem',
            textDecoration: 'none', border: '1px solid var(--border-light)',
          }}
        >
          Descargar en App Store
        </a>
      </div>

      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '1rem', color: 'var(--text-primary)' }}>
        Cómo empezar
      </h2>
      <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 3rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: '1rem',
              background: 'var(--bg-card)', border: '1px solid var(--border-light)',
              borderRadius: '0.85rem', padding: '1.1rem 1.2rem',
            }}
          >
            <span
              style={{
                width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
                background: 'var(--primary)', color: '#fff', fontWeight: 800, fontSize: '0.95rem',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {i + 1}
            </span>
            <span>
              <span style={{ display: 'block', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.2rem' }}>
                {step.title}
              </span>
              <span style={{ display: 'block', fontSize: '0.92rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                {step.body}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '1rem', color: 'var(--text-primary)' }}>
        Por qué manejar con TriciGo
      </h2>
      <div
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: '0.85rem', marginBottom: '3rem',
        }}
      >
        {BENEFITS.map((b) => (
          <div
            key={b.title}
            style={{
              background: 'var(--bg-card)', border: '1px solid var(--border-light)',
              borderRadius: '0.85rem', padding: '1.1rem 1.2rem',
            }}
          >
            <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 0.35rem', color: 'var(--text-primary)' }}>
              {b.title}
            </h3>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              {b.body}
            </p>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '1rem', color: 'var(--text-primary)' }}>
        Preguntas frecuentes
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '3rem' }}>
        {FAQ.map((f) => (
          <details
            key={f.q}
            style={{
              background: 'var(--bg-card)', border: '1px solid var(--border-light)',
              borderRadius: '0.85rem', padding: '0.9rem 1.1rem',
            }}
          >
            <summary style={{ fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.95rem' }}>
              {f.q}
            </summary>
            <p style={{ margin: '0.6rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {f.a}
            </p>
          </details>
        ))}
      </div>

      <div
        style={{
          background: 'linear-gradient(135deg, var(--primary), #FB923C)',
          borderRadius: '1rem', padding: '2rem 1.5rem', textAlign: 'center', color: '#fff',
        }}
      >
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, margin: '0 0 0.5rem' }}>
          Tu vehículo puede trabajar para ti
        </h2>
        <p style={{ margin: '0 0 1.25rem', fontSize: '0.95rem', opacity: 0.95 }}>
          Descarga TriciGo Conductor y completa tu registro hoy.
        </p>
        <a
          href={PLAY_DRIVER}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block', padding: '0.8rem 1.5rem', borderRadius: '0.75rem',
            background: '#fff', color: 'var(--primary)', fontWeight: 800, fontSize: '0.95rem',
            textDecoration: 'none',
          }}
        >
          Empezar ahora
        </a>
      </div>
    </main>
  );
}
