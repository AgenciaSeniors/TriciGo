/**
 * Lightweight fuzzy string matching using normalized Levenshtein distance.
 * No external dependencies.
 */

/** Compute Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,       // deletion
        curr[j - 1]! + 1,   // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Strip accents from a string for accent-insensitive comparison */
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Check if `query` fuzzy-matches `target`.
 * Returns true if:
 *  - target contains query as substring (accent-insensitive), OR
 *  - normalized Levenshtein distance < threshold (default 0.3)
 */
export function fuzzyMatch(query: string, target: string, threshold = 0.3): boolean {
  const q = stripAccents(query.toLowerCase().trim());
  const t = stripAccents(target.toLowerCase().trim());

  if (q.length === 0) return false;

  // Exact substring match (fast path)
  if (t.includes(q)) return true;

  // For short queries, only check substring
  if (q.length < 3) return false;

  // Check fuzzy match against each word in target
  const targetWords = t.split(/\s+/);
  for (const word of targetWords) {
    if (word.length === 0) continue;
    const maxLen = Math.max(q.length, word.length);
    const dist = levenshtein(q, word);
    if (dist / maxLen < threshold) return true;
  }

  // Also check against the full target if query is long enough
  if (q.length >= 4) {
    const maxLen = Math.max(q.length, t.length);
    const dist = levenshtein(q, t);
    if (dist / maxLen < threshold) return true;
  }

  return false;
}
