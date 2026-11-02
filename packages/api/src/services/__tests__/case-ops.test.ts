import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

import { CASES_UNAVAILABLE, caseOpsService } from '../case-ops.service';

const ok = (data: unknown) => ({ data, error: null });

/** A query on ride_dispute_escalations that resolves to `result`. */
function escalationQuery(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.maybeSingle = vi.fn(() => Promise.resolve(result));
  return q;
}

beforeEach(() => {
  mockRpc.mockReset();
  mockFrom.mockReset();
});

describe('caseOpsService: tickets', () => {
  it('changes a status as the reviewer saw it', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, status: 'resolved' }));
    await caseOpsService.updateTicket('t-1', 'resolved', 'open');
    expect(mockRpc).toHaveBeenCalledWith('ops_update_ticket', {
      p_ticket_id: 't-1', p_status: 'resolved', p_expected_status: 'open',
    });
  });

  it('answers and returns the message and the new status', async () => {
    const message = { id: 'm-1', ticket_id: 't-1', message: 'Hola', is_admin: true };
    mockRpc.mockResolvedValueOnce(ok({ success: true, status: 'in_progress', message }));
    await expect(caseOpsService.replyTicket('t-1', '  Hola  ')).resolves.toEqual({ message, status: 'in_progress' });
    expect(mockRpc).toHaveBeenCalledWith('ops_reply_ticket', { p_ticket_id: 't-1', p_message: 'Hola' });
  });

  it("throws the server's refusal as an AppError with its code", async () => {
    mockRpc.mockResolvedValueOnce(ok({ error: 'ticket_changed', status: 'closed' }));
    const err = await caseOpsService.updateTicket('t-1', 'resolved', 'open').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('ticket_changed');
  });

  it('says the functions are not deployed when the migration is missing', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    const err = await caseOpsService.replyTicket('t-1', 'Hola').catch((e: unknown) => e);
    expect((err as AppError).code).toBe(CASES_UNAVAILABLE);
  });

  it('rethrows any other database error', async () => {
    const dbErr = { code: '57014', message: 'canceling statement' };
    mockRpc.mockResolvedValueOnce({ data: null, error: dbErr });
    await expect(caseOpsService.updateTicket('t-1', 'closed', 'open')).rejects.toBe(dbErr);
  });
});

describe('caseOpsService: incidents and lost items', () => {
  it('resolves an incident, hiding the review it reports', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true }));
    await caseOpsService.updateIncident('i-1', 'resolved', 'open', { notes: ' Ofensiva ', hideReview: true });
    expect(mockRpc).toHaveBeenCalledWith('ops_update_incident', {
      p_incident_id: 'i-1', p_status: 'resolved', p_expected_status: 'open', p_notes: 'Ofensiva', p_hide_review: true,
    });
  });

  it('moves an incident with no note and no review', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true }));
    await caseOpsService.updateIncident('i-1', 'investigating', 'open');
    expect(mockRpc.mock.calls[0]![1]).toMatchObject({ p_notes: null, p_hide_review: false });
  });

  it('saves the notes of a lost item and closes it', async () => {
    mockRpc.mockResolvedValue(ok({ success: true }));
    await caseOpsService.saveLostItemNotes('l-1', 'reported', '  ');
    await caseOpsService.closeLostItem('l-1', 'reported', 'Devuelto en persona');
    expect(mockRpc.mock.calls).toEqual([
      ['ops_update_lost_item', { p_item_id: 'l-1', p_action: 'notes', p_expected_status: 'reported', p_notes: null }],
      ['ops_update_lost_item', { p_item_id: 'l-1', p_action: 'close', p_expected_status: 'reported', p_notes: 'Devuelto en persona' }],
    ]);
  });
});

describe('caseOpsService: disputes', () => {
  it('takes a dispute and saves its notes', async () => {
    mockRpc.mockResolvedValue(ok({ success: true }));
    await caseOpsService.takeDispute('d-1', 'open');
    await caseOpsService.saveDisputeNotes('d-1', 'under_review', 'Pedir capturas');
    expect(mockRpc.mock.calls).toEqual([
      ['ops_update_dispute', { p_dispute_id: 'd-1', p_action: 'take', p_expected_status: 'open', p_notes: null }],
      ['ops_update_dispute', { p_dispute_id: 'd-1', p_action: 'notes', p_expected_status: 'under_review', p_notes: 'Pedir capturas' }],
    ]);
  });

  it('resolves without a refund', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, status: 'resolved_driver' }));
    await caseOpsService.resolveDisputeWithoutRefund('d-1', 'warning_issued', 'open', 'Aviso dado');
    expect(mockRpc).toHaveBeenCalledWith('ops_resolve_dispute_without_refund', {
      p_dispute_id: 'd-1', p_resolution: 'warning_issued', p_expected_status: 'open', p_notes: 'Aviso dado',
    });
  });

  it('escalates a refund and returns the proposal id', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, status: 'escalated', escalation_id: 'e-1' }));
    await expect(caseOpsService.escalateDispute('d-1', 'partial_refund', 1500, 'open', 'Cobró de más')).resolves.toBe('e-1');
    expect(mockRpc).toHaveBeenCalledWith('ops_escalate_dispute', {
      p_dispute_id: 'd-1', p_resolution: 'partial_refund', p_suggested_trc: 1500, p_expected_status: 'open', p_reason: 'Cobró de más',
    });
  });

  it('pays a proposal as the admin saw it', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, refund_transaction_id: 'tx-1' }));
    await expect(caseOpsService.refundEscalation('e-1', 1500)).resolves.toBe('tx-1');
    expect(mockRpc).toHaveBeenCalledWith('admin_refund_escalated_dispute', { p_escalation_id: 'e-1', p_expected_trc: 1500 });
  });

  it('reads the pending proposal of a dispute', async () => {
    const row = { id: 'e-1', dispute_id: 'd-1', suggested_trc: 1500, status: 'pending' };
    const q = escalationQuery(ok(row));
    mockFrom.mockReturnValueOnce(q);
    await expect(caseOpsService.getPendingEscalation('d-1')).resolves.toEqual(row);
    expect(mockFrom).toHaveBeenCalledWith('ride_dispute_escalations');
    expect(q.eq).toHaveBeenCalledWith('dispute_id', 'd-1');
    expect(q.eq).toHaveBeenCalledWith('status', 'pending');
  });

  it('reads no proposal while the table does not exist', async () => {
    mockFrom.mockReturnValueOnce(escalationQuery({ data: null, error: { code: 'PGRST205', message: 'Could not find the table' } }));
    await expect(caseOpsService.getPendingEscalation('d-1')).resolves.toBeNull();
  });
});

describe('caseOpsService: moderation', () => {
  it('shows or hides a review as the reviewer saw it', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true, is_visible: false }));
    await caseOpsService.setReviewVisibility('r-1', false, true);
    expect(mockRpc).toHaveBeenCalledWith('ops_set_review_visibility', { p_review_id: 'r-1', p_visible: false, p_expected_visible: true });
  });

  it('resolves a fraud alert', async () => {
    mockRpc.mockResolvedValueOnce(ok({ success: true }));
    await caseOpsService.resolveFraudAlert('f-1', '');
    expect(mockRpc).toHaveBeenCalledWith('ops_resolve_fraud_alert', { p_alert_id: 'f-1', p_note: null });
  });
});
