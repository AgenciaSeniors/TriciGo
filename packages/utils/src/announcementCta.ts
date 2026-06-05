import type { ServiceTypeSlug } from '@tricigo/types';

/**
 * Home announcement (CAMPAÑAS) call-to-action resolution.
 *
 * Announcements store a free-form `cta_url`. In the mobile client "request a
 * ride" is NOT a route — it's an in-screen flow state — so a `cta_url` like
 * `/book` (which only exists in the WEB app) used to `router.push('/book')`
 * and render Expo Router's `+not-found.tsx` (the 404 the user reported).
 *
 * This module is the single source of truth — shared by the client handler
 * and the admin editor — for what a `cta_url` means and which targets are
 * valid, so the two can never drift apart.
 */

export type AnnouncementCtaAction =
  /** Start the in-app booking flow, optionally with a service preselected. */
  | { kind: 'book'; service?: ServiceTypeSlug }
  /** Navigate to a known in-app route. */
  | { kind: 'route'; path: string }
  /** Open via the system handler (https/mailto/tel/tricigo). */
  | { kind: 'external'; url: string }
  /** Do nothing — empty or an unrecognised path (backstop against a 404). */
  | { kind: 'none' };

export interface AnnouncementCtaTarget {
  /** The `cta_url` value stored in the DB. */
  value: string;
  /** Spanish label shown in the admin selector. */
  labelEs: string;
}

/**
 * Friendly in-app targets offered by the admin announcement editor. Keeping
 * the list here (not inline in the admin page) means the app's resolver and
 * the admin's choices are defined together.
 */
export const ANNOUNCEMENT_CTA_TARGETS: AnnouncementCtaTarget[] = [
  { value: '/(tabs)', labelEs: 'Pedir viaje (Inicio)' },
  { value: '/(tabs)?service=mensajeria', labelEs: 'Enviar paquete (Mensajería)' },
  { value: '/profile/referral', labelEs: 'Códigos y referidos' },
  { value: '/profile/blog', labelEs: 'Novedades / Blog' },
  { value: '/(tabs)/wallet', labelEs: 'Billetera (TriciCoin)' },
  { value: '/profile/saved-locations', labelEs: 'Lugares guardados' },
  { value: '/notifications', labelEs: 'Notificaciones' },
  { value: '/support', labelEs: 'Soporte' },
];

const VALID_SERVICE_SLUGS: readonly ServiceTypeSlug[] = [
  'triciclo_basico',
  'triciclo_premium',
  'triciclo_cargo',
  'moto_standard',
  'auto_standard',
  'auto_confort',
  'mensajeria',
];

/**
 * Known top-level client route prefixes (Expo Router). Any `/path` whose first
 * segment is here is push-able; anything else resolves to `{ kind: 'none' }`
 * so a stale or typo'd `cta_url` can never render the 404 again.
 */
const KNOWN_ROUTE_PREFIXES: readonly string[] = [
  '/(tabs)',
  '/profile',
  '/ride',
  '/chat',
  '/notifications',
  '/support',
  '/promo',
  '/refer',
  '/gift',
  '/driver-profile',
];

const EXTERNAL_SCHEME = /^(?:https?:|mailto:|tel:|tricigo:)/i;

function parseServiceParam(qs: string | undefined): ServiceTypeSlug | undefined {
  if (!qs) return undefined;
  const match = qs.match(/(?:^|&)service=([^&]+)/);
  if (!match) return undefined;
  const raw = decodeURIComponent(match[1]!);
  return (VALID_SERVICE_SLUGS as readonly string[]).includes(raw)
    ? (raw as ServiceTypeSlug)
    : undefined;
}

/**
 * Resolve a stored `cta_url` into a concrete action for the client to dispatch.
 * Never throws; unknown input degrades to `{ kind: 'none' }`.
 */
export function resolveAnnouncementCta(
  url: string | null | undefined,
): AnnouncementCtaAction {
  const trimmed = url?.trim();
  if (!trimmed) return { kind: 'none' };

  if (EXTERNAL_SCHEME.test(trimmed)) return { kind: 'external', url: trimmed };
  if (!trimmed.startsWith('/')) return { kind: 'none' };

  const [path, qs] = trimmed.split('?');

  // Booking intent: the home tab, or the web-parity alias `/book`.
  if (path === '/(tabs)' || path === '/(tabs)/index' || path === '/book') {
    const service = parseServiceParam(qs);
    return service ? { kind: 'book', service } : { kind: 'book' };
  }

  // Known in-app route → navigate. Unknown → none (backstop against a 404).
  const isKnown = KNOWN_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path!.startsWith(`${prefix}/`),
  );
  return isKnown ? { kind: 'route', path: trimmed } : { kind: 'none' };
}

/**
 * Whether a `cta_url` is safe to store. Empty is allowed (announcement with no
 * CTA button). Used by the admin editor to reject routes that would 404.
 */
export function isValidAnnouncementCta(url: string): boolean {
  if (url.trim() === '') return true;
  return resolveAnnouncementCta(url).kind !== 'none';
}
