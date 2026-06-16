// Local-SEO data for the per-city landing pages
// (/transporte/[provincia]/[ciudad]). Mirrors lib/coverage.ts but one level
// deeper: a curated set of high-demand municipalities (provincial capitals +
// tourism/oriente hubs), each with unique human-reviewed copy. NOT all 168
// municipios — only the curated cities below — to avoid thin/doorway content.

// Import from the `./cuba-geo` subpath (not the barrel) — see the note in
// lib/coverage.ts: the @tricigo/utils index re-exports client hooks that would
// taint this Server Component. cuba-geo.ts is pure data.
import { CUBA_PROVINCES, CUBA_MUNICIPALITIES, type GeoOption } from '@tricigo/utils/cuba-geo';

export interface CityFaq {
  q: string;
  a: string;
}

export interface CityContent {
  /** <meta name="description"> — 120-160 chars, includes the city name. */
  metaDescription: string;
  /** Lead sentence(s) under the H1. */
  intro: string;
  /** 2-3 unique paragraphs specific to the city (avoids thin/duplicate content). */
  bodyParagraphs: string[];
  /** City-tailored FAQ (rendered visibly + as FAQPage JSON-LD). */
  faqs: CityFaq[];
}

export interface CityPage {
  provinceValue: string;
  provinceName: string;
  provinceSlug: string;
  cityValue: string;
  cityName: string;
  citySlug: string;
  content: CityContent;
}

// Curated cities, keyed by [province value, municipality value] from cuba-geo.
// Every `city` here MUST be a real municipality value of its `province`.
// City values are unique across this list, so CITY_CONTENT can be keyed by the
// city value alone (mirrors PROVINCE_CONTENT).
const CURATED: { province: string; city: string }[] = [
  { province: 'pinar_del_rio', city: 'pinar_del_rio' },
  { province: 'pinar_del_rio', city: 'vinales' },
  { province: 'artemisa', city: 'artemisa' },
  { province: 'artemisa', city: 'san_antonio_de_los_banos' },
  { province: 'la_habana', city: 'habana_vieja' },
  { province: 'la_habana', city: 'plaza_de_la_revolucion' },
  { province: 'la_habana', city: 'playa' },
  { province: 'la_habana', city: 'centro_habana' },
  { province: 'mayabeque', city: 'san_jose_de_las_lajas' },
  { province: 'mayabeque', city: 'guines' },
  { province: 'matanzas', city: 'matanzas' },
  { province: 'matanzas', city: 'cardenas' },
  { province: 'villa_clara', city: 'santa_clara' },
  { province: 'cienfuegos', city: 'cienfuegos' },
  { province: 'sancti_spiritus', city: 'sancti_spiritus' },
  { province: 'sancti_spiritus', city: 'trinidad' },
  { province: 'ciego_de_avila', city: 'ciego_de_avila' },
  { province: 'ciego_de_avila', city: 'moron' },
  { province: 'camaguey', city: 'camaguey' },
  { province: 'las_tunas', city: 'las_tunas' },
  { province: 'holguin', city: 'holguin' },
  { province: 'granma', city: 'bayamo' },
  { province: 'granma', city: 'manzanillo' },
  { province: 'santiago_de_cuba', city: 'santiago_de_cuba' },
  { province: 'guantanamo', city: 'guantanamo' },
  { province: 'guantanamo', city: 'baracoa' },
];

function toSlug(value: string): string {
  return value.replace(/_/g, '-');
}
function slugToValue(slug: string): string {
  return slug.replace(/-/g, '_');
}

function buildCity(province: string, city: string): CityPage | null {
  const prov = CUBA_PROVINCES.find((p) => p.value === province);
  const muni = (CUBA_MUNICIPALITIES[province] ?? []).find((m: GeoOption) => m.value === city);
  const content = CITY_CONTENT[city];
  if (!prov || !muni || !content) return null;
  return {
    provinceValue: province,
    provinceName: prov.label,
    provinceSlug: toSlug(province),
    cityValue: city,
    cityName: muni.label,
    citySlug: toSlug(city),
    content,
  };
}

/** All {provincia, ciudad} slug pairs that have copy (generateStaticParams + sitemap). */
export function getAllCityParams(): { provincia: string; ciudad: string }[] {
  return CURATED
    .filter(({ city }) => CITY_CONTENT[city])
    .map(({ province, city }) => ({ provincia: toSlug(province), ciudad: toSlug(city) }));
}

export function getCityBySlug(provincia: string, ciudad: string): CityPage | null {
  const province = slugToValue(provincia);
  const city = slugToValue(ciudad);
  const pair = CURATED.find((x) => x.province === province && x.city === city);
  if (!pair) return null;
  return buildCity(province, city);
}

/** Curated cities of a province that have copy (for the province page list). */
export function getCitiesForProvince(provinceValue: string): CityPage[] {
  return CURATED
    .filter((x) => x.province === provinceValue && CITY_CONTENT[x.city])
    .map((x) => buildCity(x.province, x.city))
    .filter((c): c is CityPage => c !== null);
}

// ── Per-city copy (unique, reviewed; see lib/cities-content.ts) ──
export { CITY_CONTENT } from './cities-content';
import { CITY_CONTENT } from './cities-content';
