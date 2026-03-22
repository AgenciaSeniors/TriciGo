export function formatAdminDate(date: string | Date | null | undefined): string {
  if (!date) return '\u2014';
  const d = new Date(date);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatAdminDateShort(date: string | Date | null | undefined): string {
  if (!date) return '\u2014';
  const d = new Date(date);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}
