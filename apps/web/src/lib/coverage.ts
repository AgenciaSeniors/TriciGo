// Local-SEO coverage data for the per-province landing pages
// (/transporte and /transporte/[provincia]). The province list and the
// municipality lists are the single source of truth in @tricigo/utils
// (cuba-geo.ts); here we add the unique, human-reviewed marketing copy per
// province and the slug <-> value mapping for clean URLs.

// Import from the `./cuba-geo` subpath (not the barrel): the @tricigo/utils
// index re-exports client-hook modules (animateCoordinate, useDebouncePress),
// which would taint this Server Component. cuba-geo.ts is pure data.
import { CUBA_PROVINCES, CUBA_MUNICIPALITIES, type GeoOption } from '@tricigo/utils/cuba-geo';

export interface ProvinceFaq {
  q: string;
  a: string;
}

export interface ProvinceContent {
  /** <meta name="description"> — 120-160 chars, includes the province name. */
  metaDescription: string;
  /** Lead sentence(s) under the H1. */
  intro: string;
  /** 2-3 unique paragraphs specific to the province (avoids thin/duplicate content). */
  bodyParagraphs: string[];
  /** Province-tailored FAQ (rendered visibly + as FAQPage JSON-LD). */
  faqs: ProvinceFaq[];
}

/** `la_habana` -> `la-habana` for clean, hyphenated URLs. */
export function provinceSlug(value: string): string {
  return value.replace(/_/g, '-');
}

/** `la-habana` -> `la_habana` to look the province up in the geo data. */
export function slugToValue(slug: string): string {
  return slug.replace(/-/g, '_');
}

export interface ProvincePage {
  value: string;
  name: string;
  slug: string;
  municipios: GeoOption[];
  content: ProvinceContent;
}

/** All province slugs that have copy (used by generateStaticParams + sitemap). */
export function getAllProvinceSlugs(): string[] {
  return CUBA_PROVINCES.filter((p) => PROVINCE_CONTENT[p.value]).map((p) => provinceSlug(p.value));
}

export function getProvinceBySlug(slug: string): ProvincePage | null {
  const value = slugToValue(slug);
  const prov = CUBA_PROVINCES.find((p) => p.value === value);
  const content = PROVINCE_CONTENT[value];
  if (!prov || !content) return null;
  return {
    value,
    name: prov.label,
    slug: provinceSlug(value),
    municipios: CUBA_MUNICIPALITIES[value] ?? [],
    content,
  };
}

/** Every province that has copy, in the canonical CUBA_PROVINCES order. */
export function getAllProvinces(): ProvincePage[] {
  return CUBA_PROVINCES
    .map((p) => getProvinceBySlug(provinceSlug(p.value)))
    .filter((p): p is ProvincePage => p !== null);
}

// ── Per-province copy (unique, reviewed; see lib/coverage-content.ts) ──
// Keyed by province `value` (the CUBA_PROVINCES key). Filled from the
// generated + adversarially-verified content blocks.
export { PROVINCE_CONTENT } from './coverage-content';
import { PROVINCE_CONTENT } from './coverage-content';
