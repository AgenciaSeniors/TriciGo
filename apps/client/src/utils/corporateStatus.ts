// ============================================================
// TriciGo Client — badge for a corporate account's status
// The status column only takes these four values (a CHECK on
// corporate_accounts.status). Showing the raw value would put
// "approved" in English on a Spanish screen.
//
// Plain TypeScript, so the client's vitest setup can test it.
// ============================================================

import type { CorporateAccountStatus } from '@tricigo/types';

export interface CorporateStatusBadge {
  /** Key in the rider namespace; `label` is its Spanish default. */
  labelKey: string;
  label: string;
  variant: 'success' | 'warning' | 'error';
}

// Feminine, like "la cuenta" it labels.
const CORPORATE_STATUS_BADGES: Record<CorporateAccountStatus, CorporateStatusBadge> = {
  pending: { labelKey: 'corporate.status_pending', label: 'En revisión', variant: 'warning' },
  approved: { labelKey: 'corporate.status_approved', label: 'Aprobada', variant: 'success' },
  suspended: { labelKey: 'corporate.status_suspended', label: 'Suspendida', variant: 'error' },
  rejected: { labelKey: 'corporate.status_rejected', label: 'Rechazada', variant: 'error' },
};

export function corporateStatusBadge(status: CorporateAccountStatus): CorporateStatusBadge {
  return CORPORATE_STATUS_BADGES[status];
}
