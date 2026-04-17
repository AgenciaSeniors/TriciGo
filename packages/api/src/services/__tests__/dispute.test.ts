import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockQueryChain, UUID } from './helpers/mockSupabase';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { disputeService } from '../dispute.service';

const MOCK_DISPUTE = {
  id: UUID.DISPUTE_1,
  ride_id: UUID.RIDE_1,
  opened_by: UUID.USER_1,
  reason: 'pricing',
  description: 'Fare was higher than estimated',
  evidence_urls: [],
  status: 'open',
  priority: 'normal',
  respondent_id: UUID.USER_2,
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
      data: { customer_id: UUID.USER_1, driver_id: UUID.DRIVER_1 },
      error: null,
    });
    const mockRideEq = vi.fn(() => ({ single: mockRideSingle }));

    // Mock driver profile fetch
    const mockDriverSingle = vi.fn().mockResolvedValue({
      data: { user_id: UUID.USER_2 },
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
      return createMockQueryChain();
    });

    const result = await disputeService.createDispute({
      ride_id: UUID.RIDE_1,
      opened_by: UUID.USER_1,
      reason: 'pricing',
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
        ride_id: UUID.RIDE_1,
        opened_by: UUID.USER_1,
        reason: 'pricing',
        description: 'Fare issue test',
      }),
    ).rejects.toEqual(err);
  });
});

describe('disputeService.getDisputeByRide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns dispute for a ride', async () => {
    const chain = createMockQueryChain({ data: MOCK_DISPUTE, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await disputeService.getDisputeByRide(UUID.RIDE_1);
    expect(result).toEqual(MOCK_DISPUTE);
    expect(mockFrom).toHaveBeenCalledWith('ride_disputes');
  });

  it('returns null when no dispute exists', async () => {
    const chain = createMockQueryChain({ data: null, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await disputeService.getDisputeByRide(UUID.RIDE_2);
    expect(result).toBeNull();
  });
});

describe('disputeService.getMyDisputes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns disputes where user is opener or respondent', async () => {
    const chain = createMockQueryChain({ data: [MOCK_DISPUTE], error: null });
    mockFrom.mockReturnValue(chain);

    const result = await disputeService.getMyDisputes(UUID.USER_1);
    expect(result).toHaveLength(1);
    expect(chain.or).toHaveBeenCalledWith(`opened_by.eq.${UUID.USER_1},respondent_id.eq.${UUID.USER_1}`);
  });
});

describe('disputeService.getAllDisputes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all disputes without filter', async () => {
    const chain = createMockQueryChain({ data: [MOCK_DISPUTE], error: null });
    mockFrom.mockReturnValue(chain);

    const result = await disputeService.getAllDisputes();
    expect(result).toHaveLength(1);
    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it('filters by status when provided', async () => {
    const chain = createMockQueryChain({ data: [], error: null });
    mockFrom.mockReturnValue(chain);

    await disputeService.getAllDisputes({ status: 'open' });
    expect(chain.eq).toHaveBeenCalledWith('status', 'open');
  });
});

describe('disputeService.respondToDispute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates respondent fields and status', async () => {
    const chain = createMockQueryChain({ data: null, error: null });
    mockFrom.mockReturnValue(chain);

    await disputeService.respondToDispute(UUID.DISPUTE_1, UUID.USER_2, 'I dispute the claim', ['photo.jpg']);

    expect(mockFrom).toHaveBeenCalledWith('ride_disputes');
    expect(chain.update).toHaveBeenCalledWith(
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
      UUID.DISPUTE_1, UUID.ADMIN_1, 'full_refund', 5000, 'Customer was right',
    );

    expect(result).toBe('txn-123');
    expect(mockRpc).toHaveBeenCalledWith('process_dispute_refund', {
      p_dispute_id: UUID.DISPUTE_1,
      p_admin_id: UUID.ADMIN_1,
      p_refund_amount_trc: 5000,
      p_resolution: 'full_refund',
      p_resolution_notes: 'Customer was right',
    });
  });

  it('handles no_action resolution without RPC', async () => {
    // Mock update for deny
    const updateChain = createMockQueryChain({ data: null, error: null });

    // Mock dispute fetch for ride_id
    const fetchChain = createMockQueryChain({ data: { ride_id: UUID.RIDE_1 }, error: null });

    // Mock ride status restore
    const rideChain = createMockQueryChain({ data: null, error: null });

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ride_disputes') {
        callCount++;
        if (callCount === 1) return updateChain;
        return fetchChain;
      }
      if (table === 'rides') return rideChain;
      return createMockQueryChain();
    });

    const result = await disputeService.resolveDispute(
      UUID.DISPUTE_1, UUID.ADMIN_1, 'no_action', 0, 'No grounds for refund',
    );

    expect(result).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(updateChain.update).toHaveBeenCalledWith(
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
    const chain = createMockQueryChain({ data: null, error: null });
    mockFrom.mockReturnValue(chain);

    await disputeService.updateDisputeStatus(UUID.DISPUTE_1, {
      status: 'under_review',
      assigned_to: UUID.ADMIN_1,
    });

    expect(chain.update).toHaveBeenCalledWith({
      status: 'under_review',
      assigned_to: UUID.ADMIN_1,
    });
  });
});

describe('disputeService.addAdminNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates admin notes', async () => {
    const chain = createMockQueryChain({ data: null, error: null });
    mockFrom.mockReturnValue(chain);

    await disputeService.addAdminNotes(UUID.DISPUTE_1, 'Reviewed evidence, driver was at fault');

    expect(chain.update).toHaveBeenCalledWith({
      admin_notes: 'Reviewed evidence, driver was at fault',
    });
    expect(chain.eq).toHaveBeenCalledWith('id', UUID.DISPUTE_1);
  });

  it('throws on error', async () => {
    const err = { message: 'Update failed', code: '42P01' };
    const chain = createMockQueryChain({ data: null, error: err });
    mockFrom.mockReturnValue(chain);

    await expect(disputeService.addAdminNotes(UUID.DISPUTE_1, 'notes')).rejects.toEqual(err);
  });
});
