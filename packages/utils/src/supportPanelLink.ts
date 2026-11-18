/**
 * The admin panel page a staff support push opens when tapped.
 *
 * Support alerts (`_support_send`, 00628/00683) reach operators and admins on whatever TriciGo app
 * they have installed, and carry `data.url` = the ride's assist page. Without this the rider and
 * driver apps treated them as plain `system` pushes and opened their own home, so the operator had
 * to wait for the e-mail to get to the ride.
 *
 * Only the exact assist page is accepted, matched as a whole string: an `https://admin.tricigo.com`
 * URL with any other host, path, query or fragment is ignored. React Native's `URL` does not
 * implement `host`/`pathname`, so the check is a regex on the full string.
 */
const ASSIST_PAGE =
  /^https:\/\/admin\.tricigo\.com\/rides\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/assist$/i;

export function supportPanelLink(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const { event, url } = data as Record<string, unknown>;
  if (typeof event !== 'string' || !event.startsWith('support_')) return null;
  if (typeof url !== 'string' || !ASSIST_PAGE.test(url)) return null;
  return url;
}
