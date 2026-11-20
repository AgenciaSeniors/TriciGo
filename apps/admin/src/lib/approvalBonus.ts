import type { ApprovalBonus } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';

/** The toast after approving a driver: the approval, plus what happened to the approval bonus (00686). */
export interface ApprovalToast {
  type: 'success' | 'warning';
  /** admin.json key */
  key: string;
  defaultValue: string;
  values?: Record<string, string>;
}

/**
 * A warning when the driver was approved without the bonus they should get, so whoever approved
 * knows an admin has to look at it. Null bonus: not the profile's first approval, or 00686 is not
 * applied yet.
 */
export function approvalToast(bonus: ApprovalBonus | null): ApprovalToast {
  switch (bonus?.status) {
    case 'paid':
      return {
        type: 'success',
        key: 'drivers.approved_bonus_paid',
        defaultValue: 'Conductor aprobado. Se le acreditaron {{amount}} de bono.',
        values: { amount: formatCUP(bonus.amountCup ?? 0) },
      };
    case 'already_paid':
      return {
        type: 'success',
        key: 'drivers.approved_bonus_already_paid',
        defaultValue: 'Conductor aprobado. Ya había cobrado el bono de aprobación.',
      };
    case 'disabled':
      return {
        type: 'success',
        key: 'drivers.approved_bonus_disabled',
        defaultValue: 'Conductor aprobado. El bono de aprobación está apagado en Configuración.',
      };
    case 'no_phone':
      return {
        type: 'warning',
        key: 'drivers.approved_bonus_no_phone',
        defaultValue: 'Conductor aprobado, sin bono: no tiene un teléfono confirmado.',
      };
    case 'invalid_amount':
      return {
        type: 'warning',
        key: 'drivers.approved_bonus_invalid_amount',
        defaultValue: 'Conductor aprobado, sin bono: el monto del bono en Configuración no es válido.',
      };
    case 'failed':
      return {
        type: 'warning',
        key: 'drivers.approved_bonus_failed',
        defaultValue: 'Conductor aprobado, pero el bono no se pudo acreditar. Un admin tiene que cargarlo a mano.',
      };
    default:
      return { type: 'success', key: 'drivers.approved_success', defaultValue: 'Conductor aprobado' };
  }
}
