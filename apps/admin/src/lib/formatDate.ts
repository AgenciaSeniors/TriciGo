import { cubaTimeZone } from '@tricigo/utils';

// Server timestamps are UTC; the admin manages Cuba data, so pin display to
// Cuba's clock (cubaTimeZone; project convention) \u2014 otherwise the admin's own browser zone
// shifts every timestamp (audit trails became untraceable for non-Cuba admins).
export function formatAdminDate(date: string | Date | null | undefined): string {
  if (!date) return '\u2014';
  const d = new Date(date);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: cubaTimeZone(d) });
}

export function formatAdminDateShort(date: string | Date | null | undefined): string {
  if (!date) return '\u2014';
  const d = new Date(date);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', timeZone: cubaTimeZone(d) });
}
