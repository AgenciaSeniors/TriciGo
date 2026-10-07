/** Elapsed time as support reads it on the banner: "45s", "2:05", "14:30". */
export function waitLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

/** How long ago, in units every admin locale reads: "3 min", "5 h", "2 d". */
export function agoLabel(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

/** tel: link for a stored phone (E.164), or null when there is nothing to dial. */
export function telLink(phone: string | null | undefined): string | null {
  const p = (phone ?? '').replace(/[^\d+]/g, '');
  return p.replace(/\D/g, '').length >= 8 ? `tel:${p}` : null;
}
