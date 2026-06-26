// Per-service local-SEO landing pages (/triciclo, /moto, /auto, /mensajeria).
// Each targets the head term of one vehicle type (triciclo, motorina, almendrón,
// mandao). Mirrors the province/city pattern: a shared <ServiceLanding> renderer
// reads the unique copy from SERVICE_CONTENT (services-content.ts).

export interface ServiceFaq {
  q: string;
  a: string;
}

export interface ServiceContent {
  /** <title> WITHOUT the "| TriciGo" suffix (the root template appends it). */
  metaTitle: string;
  metaDescription: string;
  h1: string;
  intro: string;
  bodyParagraphs: string[];
  faqs: ServiceFaq[];
}

export interface ServiceDef {
  slug: string;
  label: string;
  /** Vehicle image in /public/images/vehicles. */
  img: string;
  /** A related blog post to cross-link. */
  blogSlug: string;
  blogLabel: string;
}

export const SERVICES: ServiceDef[] = [
  {
    slug: 'triciclo',
    label: 'Triciclo',
    img: '/images/vehicles/triciclo.png',
    blogSlug: 'triciclo-electrico-cuba',
    blogLabel: 'el triciclo eléctrico en Cuba',
  },
  {
    slug: 'moto',
    label: 'Moto',
    img: '/images/vehicles/moto.png',
    blogSlug: 'motorina-cuba-conductor-mensajero',
    blogLabel: 'la motorina como fuente de ingreso',
  },
  {
    slug: 'auto',
    label: 'Auto',
    img: '/images/vehicles/auto.png',
    blogSlug: 'tarifas-transporte-cuba-2026',
    blogLabel: 'las tarifas de transporte en Cuba 2026',
  },
  {
    slug: 'mensajeria',
    label: 'Mensajería',
    img: '/images/vehicles/mensajeria.png',
    blogSlug: 'mensajeria-a-domicilio-la-habana',
    blogLabel: 'mensajería a domicilio en La Habana',
  },
];

export function getAllServiceSlugs(): string[] {
  return SERVICES.filter((s) => CITY_HAS_CONTENT(s.slug)).map((s) => s.slug);
}

export function getService(slug: string): { def: ServiceDef; content: ServiceContent } | null {
  const def = SERVICES.find((s) => s.slug === slug);
  const content = SERVICE_CONTENT[slug];
  if (!def || !content) return null;
  return { def, content };
}

export function getOtherServices(slug: string): ServiceDef[] {
  return SERVICES.filter((s) => s.slug !== slug && CITY_HAS_CONTENT(s.slug));
}

function CITY_HAS_CONTENT(slug: string): boolean {
  return Boolean(SERVICE_CONTENT[slug]);
}

export { SERVICE_CONTENT } from './services-content';
import { SERVICE_CONTENT } from './services-content';
