import type { CanceledByRole } from '@tricigo/api';

type TFunction = (key: string, options?: { defaultValue?: string }) => string;

const CANCELED_BY_FALLBACK: Record<CanceledByRole, string> = {
  customer: 'Pasajero',
  driver: 'Conductor',
  staff: 'Soporte',
  system: 'Sistema',
};

/** Who canceled a ride and why, for the rides list and the ride detail. */
export function rideCancelSummary(
  t: TFunction,
  role: CanceledByRole | null | undefined,
  reason: string | null | undefined,
): string {
  const who = role
    ? t(`panel_view.canceled_by_${role}`, { defaultValue: CANCELED_BY_FALLBACK[role] })
    : t('panel_view.canceled_by_unknown', { defaultValue: 'Sin dato' });
  return reason ? `${who} · ${reason}` : who;
}
