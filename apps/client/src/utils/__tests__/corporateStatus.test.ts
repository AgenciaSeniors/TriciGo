import { describe, it, expect } from 'vitest';
import type { CorporateAccountStatus } from '@tricigo/types';
import { corporateStatusBadge } from '../corporateStatus';

describe('corporateStatusBadge', () => {
  it.each<[CorporateAccountStatus, string, string, 'success' | 'warning' | 'error']>([
    ['pending', 'corporate.status_pending', 'En revisión', 'warning'],
    ['approved', 'corporate.status_approved', 'Aprobada', 'success'],
    ['suspended', 'corporate.status_suspended', 'Suspendida', 'error'],
    ['rejected', 'corporate.status_rejected', 'Rechazada', 'error'],
  ])('labels %s in Spanish', (status, labelKey, label, variant) => {
    expect(corporateStatusBadge(status)).toEqual({ labelKey, label, variant });
  });

  it('never falls back to the raw English status', () => {
    const statuses: CorporateAccountStatus[] = ['pending', 'approved', 'suspended', 'rejected'];
    for (const status of statuses) {
      expect(corporateStatusBadge(status).label).not.toBe(status);
    }
  });
});
