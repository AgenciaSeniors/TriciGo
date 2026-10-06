// ============================================================
// The recipient name the public /recargar page may show.
//
// resolve-recharge-recipient answers anyone on the internet, with only a
// per-IP rate limit. Until 2026-10-06 it returned the full name of whoever
// owned a phone number, drivers and admins included: a phone-to-identity
// lookup. The payer only needs enough to recognise the person they are
// paying for, so the page now gets the first name and one initial.
//
// Pure module with no remote imports, so packages/api's vitest runs its test.
// ============================================================

export function maskRecipientName(fullName: string | null | undefined): string {
  const words = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = Array.from(words[0]).slice(0, 30).join('');
  if (words.length === 1) return first;
  const initial = Array.from(words[1])[0].toUpperCase();
  return `${first} ${initial}.`;
}
