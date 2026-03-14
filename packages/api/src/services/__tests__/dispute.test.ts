import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockSingle = vi.fn();
const mockMaybeSingle = vi.fn();
const mockSelect = vi.fn(() => ({ eq: vi.fn(() => ({ single: mockSingle, maybeSingle: mockMaybeSingle })) }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));
const mockRpc = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { disputeService } from '../dispute.service';

const MOCK_DISPUTE = {
  id: 'd-1',
  ride_id: 'r-1',
  opened_by: 'user-1',
  reason: 'wrong_fare',
  description: 'Fare was higher than estimated',
  evidence_urls: [],
  status: 'open',
  priority: 'normal',
  respondent_id: 'user-2',
  respondent_message: null,
  respondent_evidence_urls: [],
  respondent_replied_at: null,
  resolution: null,
  resolution_notes: null,
  refund_amount_trc: null,
  refund_transaction_id: null,
  assigned_to: null,
  admin_notes: null,
  sla_first_response_at: '2024-01-02T00:00:00Z',
  sla_resolution_deadline: '2024-01-04T00:00:00Z',
  support_ticket_id: null,
  incident_report_id: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: null,
  resolved_at: null,
};

describe('disputeService.createDispute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a dispute and marks ride as disputed', async () => {
    // Mock ride fetch
    const mockRideSingle = vi.fn().mockResolvedValue({
      data: { customer_id: 'user-1', driver_id: 'driver-1' },
      error: null,
    });
    const mockRideEq = vi.fn(() => ({ single: mockRideSingle }));

    // Mock driver profile fetch
    const mockDriverSingle = vi.fn().mockResolvedValue({
      data: { user_id: 'user-2' },
      error: null,
    });
    const mockDriverEq = vi.fn(() => ({ single: mockDriverSingle }));

    // Mock dispute insert
    const mockInsertSingle = vi.fn().mockResolvedValue({
      data: MOCK_DISPUTE,
      error: null,
    });
    const mockInsertSelect = vi.fn(() => ({ single: mockInsertSingle }));
    const mockInsert = vi.fn(() => ({ select: mockInsertSelect }));

    // Mock ride update
    const mockUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq }));

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'rides' && callCount === 0) {
        callCount++;
        return { select: vi.fn(() => ({ eq: mockRideEq })) };
      }
      if (table === 'driver_profiles') {
        return { select: vi.fn(() => ({ eq: mockDriverEq })) };
      }
      if (table === 'ride_disputes') {
        return { insert: mockInsert };
      }
      if (table === 'rides') {
        return { update: mockUpdate };
      }
      return { select: mockSelect };
    });

    const result = await disputeService.createDispute({
      ride_id: 'r-1',
      opened_by: 'user-1',
      reason: 'wrong_fare',
      description: 'Fare was higher than estimated',
    });

    expect(result).toEqual(MOCK_DISPUTE);
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'disputed' });
  });

  it('throws on ride fetch error', async () => {
    const err = { message: 'Ride not found', code: 'PGRST116' };
    const mockRideSingle = vi.fn().mockResolvedValue({ data: null, error: err });
    mockFrom.mockReturnValue({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockRideSingle })) })),
    });

    await expect(
      disputeService.createDispute({
        ride_id: 'r-1',
        opened_by: 'user-1',
        reason: 'wrong_fare',
        description: 'test',
      }),
    ).rejects.toEqual(err);
  });
});

describe('disputeService.getDisputeByRide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns dispute for a ride', async () => {
    const mockMaybe = vi.fn().mockResolvedValue({ data: MOCK_DISPUTE, error: null });
    const mockEq = vi.fn(() => ({ maybeSingle: mockMaybe }));
    mockFrom.mockReturnValue({
      select: vi.fn(() => ({ eq: mockEq })),
    });

    const result = await disputeService.getDisputeByRide('r-1');
    expect(result).toEqual(MOCK_DISPUTE);
    expect(mockFrom).toHaveBeenCalledWith('ride_disputes');
  });

  it('returns null when no dispute exists', async () => {
    const mockMaybe = vi.fn().mockResolvedValue({ data: null, error: null });
    const mockEq = vi.fn(() => ({ maybeSingle: mockMaybe }));
    mockFrom.mockReturnValue({
      select: vi.fn(() => ({ eq: mockEq })),
    });

    const result = await disputeService.getDisputeByRide('r-999');
    expect(result).toBeNull();
  });
});

describe('disputeService.getMyDisputes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns disputes where user is opener or respondent', async () => {
    const mockOrder = vi.fn().mockResolvedValue({ data: [MOCK_DISPUTE], error: null });
    const mockOr = vi.fn(() => ({ order: mockOrder }));
    mockFrom.mockReturnValue({
      select: vi.fn(() => ({ or: mockOr })),
    });

    const result = await disputeService.getMyDisputes('user-1');
    expect(result).toHaveLength(1);
    expect(mockOr).toHaveBeenCalledWith('opened_by.eq.user-1,respondent_id.eq.user-1');
  });
});

describe('disputeService.getAllDisputes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all disputes without filter', async () => {
    const mockLimit = vi.fn().mockResolvedValue({ data: [MOCK_DISPUTE], error: null });
    const mockOrder = vi.fn(() => ({ limit: mockLimit }));
    mockFrom.mockReturnValue({
      select: vi.fn(() => ({ order: mockOrder })),
    });

    const result = await disputeService.getAllDisputes();
    expect(result).toHaveLength(1);
    expect(mockLimit).toHaveBeenCalledWith(50);
  });

  it('filters by status when provided', async () => {
    const mockLimit = vi.fn();
    const mockEq = vi.fn().mockResolvedValue({ data: [], error: null });
    mockLimit.mockReturnValue({ eq: mockEq });
    const mockOrder = vi.fn(() => ({ limit: mockLimit }));
    mockFrom.mockReturnValue({
      select: vi.fn(() => ({ order: mockOrder })),
    });

    await disputeService.getAllDisputes({ status: 'open' });
    expect(mockEq).toHaveBeenCalledWith('status', 'open');
  });
});

describe('disputeService.respondToDispute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates respondent fields and status', async () => {
    const mockRespondentEq = vi.fn().mockResolvedValue({ error: null });
    const mockDisputeEq = vi.fn(() => ({ eq: mockRespondentEq }));
    const mockUpdate = vi.fn(() => ({ eq: mockDisputeEq }));
    mockFrom.mockReturnValue({ update: mockUpdate });

    await disputeService.respondToDispute('d-1', 'user-2', 'I dispute the claim', ['photo.jpg']);

    expect(mockFrom).toHaveBeenCalledWith('ride_disputes');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        respondent_message: 'I dispute the claim',
        respondent_evidence_urls: ['photo.jpg'],
        status: 'under_review',
      }),
    );
  });
});

describe('disputeService.resolveDispute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls RPC for refund resolutions', async () => {
    mockRpc.mockResolvedValue({ data: 'txn-123', error: null });

    const result = await disputeService.resolveDispute(
      'd-1', 'admin-1', 'full_refund', 5000, 'Customer was right',
    );

    expect(result).toBe('txn-123');
    expect(mockRpc).toHaveBeenCalledWith('process_dispute_refund', {
      p_dispute_id: 'd-1',
      p_admin_id: 'admin-1',
      p_refund_amount_trc: 5000,
      p_resolution: 'full_refund',
      p_resolution_notes: 'Customer was right',
    });
  });

  it('handles no_action resolution without RPC', async () => {
    // Mock update for deny
    const mockUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq }));

    // Mock ride status restore
    const mockRideStatusEq = vi.fn().mockResolvedValue({ error: null });
    const mockRideEq = vi.fn(() => ({ eq: mockRideStatusEq }));
    const mockRideUpdate = vi.fn(() => ({ eq: mockRideEq }));

    // Mock dispute fetch for ride_id
    const mockDisputeSingle = vi.fn().mockResolvedValue({
      data: { ride_id: 'r-1' }, error: null,
    });
    const mockDisputeSelectEq = vi.fn(() => ({ single: mockDisputeSingle }));

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ride_disputes') {
        callCount++;
        if (callCount === 1) return { update: mockUpdate };
        return { select: vi.fn(() => ({ eq: mockDisputeSelectEq })) };
      }
      if (table === 'rides') return { update: mockRideUpdate };
      return {};
    });

    const result = await disputeService.resolveDispute(
      'd-1', 'admin-1', 'no_action', 0, 'No grounds for refund',
    );

    expect(result).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'denied',
        resolution: 'no_action',
        refund_amount_trc: 0,
      }),
    );
  });
});

describe('disputeService.updateDisputeStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates status and assignment', async () => {
    const mockEq = vi.fn().mockResolvedValue({ error: null });
    const mockUpdate = vi.fn(() => ({ eq: mockEq }));
    mockFrom.mockReturnValue({ update: mockUpdate });

    await disputeService.updateDisputeStatus('d-1', {
      status: 'under_review',
      assigned_to: 'admin-1',
    });

    expect(mockUpdate).toHaveBeenCalledWith({
      status: 'under_review',
      assigned_to: 'admin-1',
    });
  });
});

describe('disputeService.addAdminNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates admin notes', async () => {
    const mockEq = vi.fn().mockResolvedValue({ error: null });
    const mockUpdate = vi.fn(() => ({ eq: mockEq }));
    mockFrom.mockReturnValue({ update: mockUpdate });

    await disputeService.addAdminNotes('d-1', 'Reviewed evidence, driver was at fault');

    expect(mockUpdate).toHaveBeenCalledWith({
      admin_notes: 'Reviewed evidence, driver was at fault',
    });
    expect(mockEq).toHaveBeenCalledWith('id', 'd-1');
  });

  it('throws on error', async () => {
    const err = { message: 'Update failed', code: '42P01' };
    const mockEq = vi.fn().mockResolvedValue({ error: err });
    const mockUpdate = vi.fn(() => ({ eq: mockEq }));
    mockFrom.mockReturnValue({ update: mockUpdate });

    await expect(disputeService.addAdminNotes('d-1', 'notes')).rejects.toEqual(err);
  });
});
