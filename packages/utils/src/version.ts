/**
 * Compare two dotted version strings (e.g. "1.1.0" vs "1.2.0") segment by
 * segment, numerically. Returns true only when `current` is strictly lower
 * than `latest`.
 *
 * Used by the in-app "update available" prompt: the mobile apps compare
 * their installed version (Constants.expoConfig.version) against the
 * `client_latest_version` / `driver_latest_version` platform_config keys.
 *
 * Fails safe: malformed input (empty string, no leading numeric segment)
 * returns false, so a bad config value can never nag users with a false
 * "update available" modal.
 */
export function isVersionOutdated(current: string, latest: string): boolean {
  const parse = (v: string): number[] | null => {
    const segments = v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((s) => parseInt(s, 10));
    if (segments.length === 0 || !Number.isFinite(segments[0])) return null;
    return segments.map((n) => (Number.isFinite(n) ? n : 0));
  };

  const cur = parse(current);
  const lat = parse(latest);
  if (!cur || !lat) return false;

  const len = Math.max(cur.length, lat.length);
  for (let i = 0; i < len; i++) {
    const a = cur[i] ?? 0;
    const b = lat[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}
