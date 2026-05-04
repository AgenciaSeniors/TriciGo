/**
 * Demo mode — para probar la web fuera de Cuba sin reconstruir todo.
 *
 * Se activa con NEXT_PUBLIC_DEMO_MODE=true en el env del build/preview.
 * Cuando está apagado (default), todas las constantes devuelven los
 * valores cubanos originales, así que el código que usa estos helpers
 * se comporta idéntico al original.
 *
 * Espejo de `apps/client/src/config/demo.ts` para mantener paridad
 * cliente móvil ↔ cliente web. Las únicas diferencias son los nombres
 * de las env vars (`NEXT_PUBLIC_*` en lugar de `EXPO_PUBLIC_*`).
 */

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

/** Cities supported as demo anchors. Keep short — it's dev tooling, not a product feature. */
export type DemoCity = 'sao_paulo' | 'rio' | 'brasilia' | 'havana';

const RAW_CITY = (process.env.NEXT_PUBLIC_DEMO_CITY ?? 'sao_paulo') as string;
export const DEMO_CITY: DemoCity =
  (['sao_paulo', 'rio', 'brasilia', 'havana'] as const).includes(RAW_CITY as DemoCity)
    ? (RAW_CITY as DemoCity)
    : 'sao_paulo';

/** [longitude, latitude] for Mapbox `center`. */
export const DEMO_CITY_COORDS_LNG_LAT: Record<DemoCity, [number, number]> = {
  sao_paulo: [-46.6333, -23.5505],
  rio: [-43.1729, -22.9068],
  brasilia: [-47.9292, -15.7942],
  havana: [-82.3666, 23.1136],
};

export const DEMO_CITY_LABEL: Record<DemoCity, string> = {
  sao_paulo: 'São Paulo',
  rio: 'Rio de Janeiro',
  brasilia: 'Brasília',
  havana: 'La Habana',
};

/**
 * Center coord the map should use when GPS is unavailable. Returns
 * La Habana when demo is off; returns the chosen demo city when on.
 */
export function getMapFallbackCoordLngLat(): [number, number] {
  if (!DEMO_MODE) return [-82.3666, 23.1136]; // HAVANA_CENTER preserved
  return DEMO_CITY_COORDS_LNG_LAT[DEMO_CITY];
}

/**
 * { latitude, longitude } fallback for code paths that use that shape.
 */
export function getMapFallbackLatLng(): { latitude: number; longitude: number } {
  const [lng, lat] = getMapFallbackCoordLngLat();
  return { latitude: lat, longitude: lng };
}

/** Dial codes allowed in demo mode (login picker). */
export const DEMO_DIAL_CODES: Array<{ code: string; label: string; emoji: string }> = [
  { code: '+53', label: 'Cuba', emoji: '🇨🇺' },
  { code: '+55', label: 'Brasil', emoji: '🇧🇷' },
];

/** Normalize a phone to E.164 using the given dial code. */
export function normalizeDemoPhone(local: string, dialCode: string): string {
  const digits = local.replace(/\D/g, '');
  if (digits.startsWith(dialCode.replace('+', ''))) return `+${digits}`;
  return `${dialCode}${digits}`;
}

/** Permissive phone validator for demo — 7..15 digits. */
export function isValidDemoPhone(local: string): boolean {
  const digits = local.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}
