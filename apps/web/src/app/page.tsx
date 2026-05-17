import type { Metadata } from 'next';
import Link from 'next/link';
import HomeClient from './HomeClient';
import { JsonLd } from '../components/JsonLd';

export const metadata: Metadata = {
  title: 'TriciGo — Pedí tu viaje | Triciclos, Motos y Autos',
  description:
    'Solicita un viaje con TriciGo. Triciclos, motos y autos disponibles 24/7. Rápido, seguro y económico.',
  alternates: {
    canonical: 'https://tricigo.com',
  },
};

/* ── Structured data for SEO ── */

const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: '¿Cómo funciona TriciGo?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Descarga la app, ingresa tu destino, elige entre triciclo, moto o auto, y confirma tu viaje. Un conductor cercano te recogerá en minutos.',
      },
    },
    {
      '@type': 'Question',
      name: '¿En qué ciudades opera TriciGo?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'TriciGo se despliega ciudad por ciudad. Revisa la app o nuestra web para ver las zonas de servicio disponibles en cada momento.',
      },
    },
    {
      '@type': 'Question',
      name: '¿Cómo pago mi viaje?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Puedes pagar en efectivo o con créditos de viaje TriciCoin. Los créditos se compran con tarjeta de crédito o débito dentro de la app.',
      },
    },
    {
      '@type': 'Question',
      name: '¿Es seguro viajar con TriciGo?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Sí. TriciGo incluye botón SOS, seguimiento en tiempo real, contactos de confianza y verificación de conductores.',
      },
    },
    {
      '@type': 'Question',
      name: '¿Cuánto cuesta un viaje?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'El precio depende de la distancia, tipo de vehículo y demanda. Siempre ves el precio estimado antes de confirmar.',
      },
    },
  ],
};

const serviceJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Service',
  name: 'TriciGo - Servicio de Transporte',
  serviceType: 'Taxi Service',
  provider: {
    '@type': 'Organization',
    name: 'TriciGo',
    url: 'https://tricigo.com',
  },
  description: 'Servicio de transporte bajo demanda. Triciclos, motos y autos disponibles 24/7.',
  offers: {
    '@type': 'Offer',
    availability: 'https://schema.org/InStock',
  },
};

/* ── Static SSR content visible to crawlers ── */

export default function HomePage() {
  return (
    <main>
      {/* ── Structured Data ── */}
      <JsonLd data={faqJsonLd} />
      <JsonLd data={serviceJsonLd} />
      {/* ── SSR: Static SEO content ── */}
      <article
        className="sr-only"
        aria-hidden="true"
        style={{ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}
      >
        <h1>Pedí tu viaje con TriciGo</h1>
        <p>
          TriciGo es la app de transporte urbano. Solicita triciclos, motos y autos
          disponibles 24/7. Rápido, seguro y económico.
        </p>

        <section>
          <h2>¿Cómo funciona?</h2>
          <ol>
            <li>
              <strong>Elige tu destino</strong> — Abre la app, ingresa tu dirección de
              recogida y destino. Verás el precio estimado al instante.
            </li>
            <li>
              <strong>Selecciona tu vehículo</strong> — Elige entre triciclo, moto o auto
              según tu preferencia y presupuesto.
            </li>
            <li>
              <strong>Viaja seguro</strong> — Tu conductor llega en minutos. Sigue el
              viaje en tiempo real y paga fácilmente.
            </li>
          </ol>
        </section>

        <section>
          <h2>Nuestros servicios</h2>
          <ul>
            <li>
              <strong>Triciclo</strong> — Económico y ecológico. Perfecto para distancias
              cortas en la ciudad.
            </li>
            <li>
              <strong>Moto</strong> — Rápido y ágil. Ideal para moverte sin tráfico por
              la ciudad.
            </li>
            <li>
              <strong>Auto</strong> — Cómodo y espacioso. La mejor opción para viajes
              largos o en grupo.
            </li>
            <li>
              <strong>Mensajería</strong> — Envía paquetes de forma rápida y segura a
              cualquier punto de la ciudad.
            </li>
          </ul>
        </section>

        <section>
          <h2>Disponibilidad</h2>
          <p>
            TriciGo se despliega ciudad por ciudad. Revisa la app para conocer las zonas
            de servicio disponibles en este momento.
          </p>
        </section>

        <section>
          <h2>¿Por qué TriciGo?</h2>
          <ul>
            <li>
              <strong>Precios transparentes</strong> — Conoce el costo antes de viajar.
              Sin sorpresas ni tarifas ocultas.
            </li>
            <li>
              <strong>Seguimiento en tiempo real</strong> — Sigue tu viaje en el mapa.
              Comparte tu ubicación con familiares.
            </li>
            <li>
              <strong>Viajes seguros</strong> — Conductores verificados, soporte 24/7 y
              botón de emergencia en cada viaje.
            </li>
            <li>
              <strong>Pagos flexibles</strong> — Paga en efectivo o con tus créditos
              de viaje TriciCoin. Tú decides.
            </li>
          </ul>
        </section>

        <section>
          <h2>Solicita tu viaje ahora</h2>
          <p>
            Descarga TriciGo y pide tu primer viaje en minutos. Disponible en Google
            Play y App Store.
          </p>
          <Link href="/book">Solicitar viaje</Link>
        </section>
      </article>

      {/* ── Client: interactive translated content ── */}
      <HomeClient />
    </main>
  );
}
