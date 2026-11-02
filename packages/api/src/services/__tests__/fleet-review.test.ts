import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewedFleetMember } from '@tricigo/types';
import { AppError } from '../../errors';

// Since 00672 the review is ops_review_fleet_member, which admins and operators share. The
// binding to the row the reviewer saw (pending_review and every reviewed column equal to the value
// shown) lives in that function: supabase/tests/00672/run.sh (Q4-Q7) tests it, and
// supabase/tests/fleet-review/run.sh the concurrent owner edits it relies on.
const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc }),
}));

import { fleetService } from '../fleet.service';

const shown: ReviewedFleetMember = {
  id: 'member-1',
  fleet_id: 'fleet-1',
  driver_name: 'Ana Pérez',
  driver_phone: '+5355512345',
  driver_email: null,
  driver_license_number: 'L-1',
  driver_id_number: null,
  license_doc_path: 'fleet-docs/corp/member-1/1760000000000-licencia.jpg',
};
const shownColumns = {
  fleet_id: 'fleet-1',
  driver_name: 'Ana Pérez',
  driver_phone: '+5355512345',
  driver_email: null,
  driver_license_number: 'L-1',
  driver_id_number: null,
  license_doc_path: 'fleet-docs/corp/member-1/1760000000000-licencia.jpg',
};

beforeEach(() => mockRpc.mockReset());

describe('fleetService.approveMember', () => {
  it('approves through the ops function, with every reviewed column as shown', async () => {
    mockRpc.mockResolvedValueOnce({ data: { success: true, status: 'active' }, error: null });

    await fleetService.approveMember(shown);

    expect(mockRpc).toHaveBeenCalledWith('ops_review_fleet_member', {
      p_member_id: 'member-1',
      p_decision: 'approved',
      p_shown: shownColumns,
      p_reason: null,
    });
  });

  it('throws FLEET_MEMBER_CHANGED when the invitation is not what was shown', async () => {
    mockRpc.mockResolvedValueOnce({ data: { error: 'member_changed' }, error: null });

    const error = await fleetService.approveMember(shown).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('FLEET_MEMBER_CHANGED');
  });

  it("throws the server's other refusals with their code", async () => {
    mockRpc.mockResolvedValueOnce({ data: { error: 'self_action' }, error: null });

    const error = await fleetService.approveMember(shown).then(() => null, (e: unknown) => e);

    expect((error as AppError).code).toBe('self_action');
  });
});

describe('fleetService.rejectMember', () => {
  it('rejects with the reason for the owner', async () => {
    mockRpc.mockResolvedValueOnce({ data: { success: true, status: 'rejected' }, error: null });

    await fleetService.rejectMember(shown, '  Licencia vencida ');

    expect(mockRpc).toHaveBeenCalledWith('ops_review_fleet_member', {
      p_member_id: 'member-1',
      p_decision: 'rejected',
      p_shown: shownColumns,
      p_reason: 'Licencia vencida',
    });
  });
});
