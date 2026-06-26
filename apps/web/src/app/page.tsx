import type { Metadata } from 'next';
import HomeClient from './HomeClient';
import { JsonLd } from '../components/JsonLd';
import { HOME_FAQS } from '@/lib/home-faq';

export const metadata: Metadata = {
  // `absolute` sets the exact <title> (bypasses the root "%s | TriciGo" template).
  title: { absolute: 'TriciGo — App de transporte: triciclo, moto y auto' },
  description:
    'Pedí un triciclo, moto o auto con TriciGo. Mirá el precio antes de viajar, en las ciudades donde estamos. Descarga gratis.',
  alternates: {
    canonical: 'https://tricigo.com',
  },
};

/* ── Structured data for SEO ── */

// Built from the shared HOME_FAQS so the structured data and the visible FAQ
// accordion in HomeClient always stay in sync.
const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: HOME_FAQS.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
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

export default function HomePage() {
  return (
    <main>
      {/* Structured data */}
      <JsonLd data={faqJsonLd} />
      <JsonLd data={serviceJsonLd} />

      {/* Interactive marketing content (server-rendered since the i18n provider
          no longer gates SSR). Its hero <h1> is the single page heading. */}
      <HomeClient />
    </main>
  );
}
