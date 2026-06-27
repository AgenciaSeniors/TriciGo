// Shared input sanitizers for public Edge Functions.

/**
 * Sanitize a free-text display name (e.g. the diaspora payer's name) before it
 * is stored and later shown in an email body or a push notification.
 *
 *  - Maps control characters (incl. newlines/tabs and C1 controls) to a space,
 *    so "John\nDoe" becomes "John Doe" and nothing can break the push/email.
 *  - Strips a few HTML metacharacters (< > & ") as defense-in-depth — the email
 *    template HTML-escapes on top of this, so this is belt-and-suspenders.
 *  - Collapses runs of spaces, trims, and caps the length at `max` chars.
 *
 * Deliberately avoids \u / \p / \s regex escapes (which are fragile to author
 * through tooling) — the control-char pass is done with codePointAt instead.
 */
export function sanitizePayerName(input: unknown, max = 60): string {
  return Array.from((input ?? '').toString())
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return ' ';
      return ch;
    })
    .join('')
    .replace(/[<>&"]/g, '')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, max);
}
