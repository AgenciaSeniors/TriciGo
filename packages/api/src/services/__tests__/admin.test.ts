import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockCreateSignedUrl = vi.fn();
const mockStorage = { from: vi.fn(() => ({ createSignedUrl: mockCreateSignedUrl })) };
const mockSupabase = { from: mockFrom, rpc: mockRpc, storage: mockStorage };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { adminService } from '../admin.service';

describe('adminService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== Dashboard ====================
  describe('getDashboardMetrics', () => {
    it('returns metrics from rpc when data is an array', async () => {
      const metrics = {
        active_rides: 5,
        total_rides_today: 42,
        online_drivers: 12,
        total_revenue_today: 500000,
        pending_verifications: 3,
        open_incidents: 1,
      };
      mockRpc.mockResolvedValueOnce({ data: [metrics], error: null });

      const result = await adminService.getDashboardMetrics();

      expect(mockRpc).toHaveBeenCalledWith('get_admin_dashboard_metrics');
      expect(result).toEqual(metrics);
    });

    it('throws on rpc error', async () => {
      const err = { message: 'RPC failed', code: '500' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(adminService.getDashboardMetrics()).rejects.toEqual(err);
    });
  });

  // ==================== Drivers ====================
  describe('getDriversByStatus', () => {
    it('returns drivers filtered by status with pagination', async () => {
      const drivers = [{ id: 'd-1', status: 'approved' }];
      const mockRange = vi.fn().mockResolvedValue({ data: drivers, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getDriversByStatus('approved' as any, 1, 10);

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(mockSelect).toHaveBeenCalledWith('*, users!inner(full_name, phone, email), vehicles(type, plate_number)');
      expect(mockEq).toHaveBeenCalledWith('status', 'approved');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockRange).toHaveBeenCalledWith(10, 19);
      expect(result).toEqual(drivers);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getDriversByStatus('pending_verification' as any)).rejects.toEqual(err);
    });
  });

  describe('getAllDrivers', () => {
    it('returns all drivers with default pagination', async () => {
      const drivers = [{ id: 'd-1' }, { id: 'd-2' }];
      const mockRange = vi.fn().mockResolvedValue({ data: drivers, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getAllDrivers();

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(mockSelect).toHaveBeenCalledWith('*, users!inner(full_name, phone, email), vehicles(type, plate_number)');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockRange).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(drivers);
    });

    it('applies status filter', async () => {
      const drivers = [{ id: 'd-1', status: 'approved' }];
      const mockEq = vi.fn().mockResolvedValue({ data: drivers, error: null });
      const mockRange = vi.fn(() => ({ eq: mockEq }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getAllDrivers(0, 20, { status: 'approved' });

      expect(mockEq).toHaveBeenCalledWith('status', 'approved');
      expect(result).toEqual(drivers);
    });

    it('applies search filter via ilike on users.full_name', async () => {
      const drivers = [{ id: 'd-1', users: { full_name: 'Carlos' } }];
      const mockIlike = vi.fn().mockResolvedValue({ data: drivers, error: null });
      const mockRange = vi.fn(() => ({ ilike: mockIlike }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getAllDrivers(0, 20, { search: 'Carlos' });

      expect(mockIlike).toHaveBeenCalledWith('users.full_name', '%Carlos%');
      expect(result).toEqual(drivers);
    });

    it('applies rating filter via gte', async () => {
      const drivers = [{ id: 'd-1', rating_avg: 4.5 }];
      const mockGte = vi.fn().mockResolvedValue({ data: drivers, error: null });
      const mockRange = vi.fn(() => ({ gte: mockGte }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getAllDrivers(0, 20, { ratingMin: 4.0 });

      expect(mockGte).toHaveBeenCalledWith('rating_avg', 4.0);
      expect(result).toEqual(drivers);
    });

    it('filters by vehicle type client-side', async () => {
      const drivers = [
        { id: 'd-1', vehicles: [{ type: 'moto', plate_number: 'M1' }] },
        { id: 'd-2', vehicles: [{ type: 'auto', plate_number: 'A1' }] },
      ];
      const mockRange = vi.fn().mockResolvedValue({ data: drivers, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getAllDrivers(0, 20, { vehicleType: 'moto' });

      expect(result).toEqual([drivers[0]]);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getAllDrivers()).rejects.toEqual(err);
    });
  });

  describe('getDriverDetail', () => {
    it('returns driver detail with profile, vehicle, documents, and score events', async () => {
      const profile = { id: 'd-1', users: { full_name: 'Juan', phone: '555', email: 'j@t.co' } };
      const vehicles = [{ id: 'v-1', type: 'moto' }];
      const documents = [{ id: 'doc-1', document_type: 'license' }];
      const scoreEvents = [{ id: 'se-1', event_type: 'ride_completed' }];

      // Query 1: driver_profiles -> select -> eq -> single
      const mockSingle1 = vi.fn().mockResolvedValue({ data: profile, error: null });
      const mockEq1 = vi.fn(() => ({ single: mockSingle1 }));
      const mockSelect1 = vi.fn(() => ({ eq: mockEq1 }));

      // Query 2: vehicles -> select -> eq(driver_id) -> eq(is_active) -> limit
      const mockLimit2 = vi.fn().mockResolvedValue({ data: vehicles, error: null });
      const mockEqActive = vi.fn(() => ({ limit: mockLimit2 }));
      const mockEqDriver2 = vi.fn(() => ({ eq: mockEqActive }));
      const mockSelect2 = vi.fn(() => ({ eq: mockEqDriver2 }));

      // Query 3: driver_documents -> select -> eq -> order
      const mockOrder3 = vi.fn().mockResolvedValue({ data: documents, error: null });
      const mockEq3 = vi.fn(() => ({ order: mockOrder3 }));
      const mockSelect3 = vi.fn(() => ({ eq: mockEq3 }));

      // Query 4: driver_score_events -> select -> eq -> order -> limit
      const mockLimit4 = vi.fn().mockResolvedValue({ data: scoreEvents, error: null });
      const mockOrder4 = vi.fn(() => ({ limit: mockLimit4 }));
      const mockEq4 = vi.fn(() => ({ order: mockOrder4 }));
      const mockSelect4 = vi.fn(() => ({ eq: mockEq4 }));

      mockFrom
        .mockReturnValueOnce({ select: mockSelect1 })
        .mockReturnValueOnce({ select: mockSelect2 })
        .mockReturnValueOnce({ select: mockSelect3 })
        .mockReturnValueOnce({ select: mockSelect4 });

      const result = await adminService.getDriverDetail('d-1');

      expect(result.profile).toEqual(profile);
      expect(result.vehicle).toEqual(vehicles[0]);
      expect(result.documents).toEqual(documents);
      expect(result.scoreEvents).toEqual(scoreEvents);
    });

    it('throws when profile query errors', async () => {
      const err = { message: 'Not found', code: 'PGRST116' };
      const mockSingle1 = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq1 = vi.fn(() => ({ single: mockSingle1 }));
      const mockSelect1 = vi.fn(() => ({ eq: mockEq1 }));

      const mockLimit2 = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockEqActive = vi.fn(() => ({ limit: mockLimit2 }));
      const mockEqDriver2 = vi.fn(() => ({ eq: mockEqActive }));
      const mockSelect2 = vi.fn(() => ({ eq: mockEqDriver2 }));

      const mockOrder3 = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockEq3 = vi.fn(() => ({ order: mockOrder3 }));
      const mockSelect3 = vi.fn(() => ({ eq: mockEq3 }));

      const mockLimit4 = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder4 = vi.fn(() => ({ limit: mockLimit4 }));
      const mockEq4 = vi.fn(() => ({ order: mockOrder4 }));
      const mockSelect4 = vi.fn(() => ({ eq: mockEq4 }));

      mockFrom
        .mockReturnValueOnce({ select: mockSelect1 })
        .mockReturnValueOnce({ select: mockSelect2 })
        .mockReturnValueOnce({ select: mockSelect3 })
        .mockReturnValueOnce({ select: mockSelect4 });

      await expect(adminService.getDriverDetail('d-1')).rejects.toEqual(err);
    });

    it('returns null vehicle when no active vehicle exists', async () => {
      const profile = { id: 'd-1', users: { full_name: 'Juan', phone: '555', email: null } };

      const mockSingle1 = vi.fn().mockResolvedValue({ data: profile, error: null });
      const mockEq1 = vi.fn(() => ({ single: mockSingle1 }));
      const mockSelect1 = vi.fn(() => ({ eq: mockEq1 }));

      const mockLimit2 = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockEqActive = vi.fn(() => ({ limit: mockLimit2 }));
      const mockEqDriver2 = vi.fn(() => ({ eq: mockEqActive }));
      const mockSelect2 = vi.fn(() => ({ eq: mockEqDriver2 }));

      const mockOrder3 = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockEq3 = vi.fn(() => ({ order: mockOrder3 }));
      const mockSelect3 = vi.fn(() => ({ eq: mockEq3 }));

      const mockLimit4 = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder4 = vi.fn(() => ({ limit: mockLimit4 }));
      const mockEq4 = vi.fn(() => ({ order: mockOrder4 }));
      const mockSelect4 = vi.fn(() => ({ eq: mockEq4 }));

      mockFrom
        .mockReturnValueOnce({ select: mockSelect1 })
        .mockReturnValueOnce({ select: mockSelect2 })
        .mockReturnValueOnce({ select: mockSelect3 })
        .mockReturnValueOnce({ select: mockSelect4 });

      const result = await adminService.getDriverDetail('d-1');

      expect(result.vehicle).toBeNull();
    });

    it('returns empty arrays when documents and score events are null', async () => {
      const profile = { id: 'd-1', users: { full_name: 'Juan', phone: '555', email: null } };

      const mockSingle1 = vi.fn().mockResolvedValue({ data: profile, error: null });
      const mockEq1 = vi.fn(() => ({ single: mockSingle1 }));
      const mockSelect1 = vi.fn(() => ({ eq: mockEq1 }));

      const mockLimit2 = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockEqActive = vi.fn(() => ({ limit: mockLimit2 }));
      const mockEqDriver2 = vi.fn(() => ({ eq: mockEqActive }));
      const mockSelect2 = vi.fn(() => ({ eq: mockEqDriver2 }));

      const mockOrder3 = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockEq3 = vi.fn(() => ({ order: mockOrder3 }));
      const mockSelect3 = vi.fn(() => ({ eq: mockEq3 }));

      const mockLimit4 = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockOrder4 = vi.fn(() => ({ limit: mockLimit4 }));
      const mockEq4 = vi.fn(() => ({ order: mockOrder4 }));
      const mockSelect4 = vi.fn(() => ({ eq: mockEq4 }));

      mockFrom
        .mockReturnValueOnce({ select: mockSelect1 })
        .mockReturnValueOnce({ select: mockSelect2 })
        .mockReturnValueOnce({ select: mockSelect3 })
        .mockReturnValueOnce({ select: mockSelect4 });

      const result = await adminService.getDriverDetail('d-1');

      expect(result.documents).toEqual([]);
      expect(result.scoreEvents).toEqual([]);
    });
  });

  describe('getDocumentUrl', () => {
    it('returns signed URL for document', async () => {
      mockCreateSignedUrl.mockResolvedValueOnce({
        data: { signedUrl: 'https://storage.example.com/signed/doc.pdf' },
        error: null,
      });

      const result = await adminService.getDocumentUrl('driver-docs/d-1/license.pdf');

      expect(mockStorage.from).toHaveBeenCalledWith('driver-documents');
      expect(mockCreateSignedUrl).toHaveBeenCalledWith('driver-docs/d-1/license.pdf', 3600);
      expect(result).toBe('https://storage.example.com/signed/doc.pdf');
    });

    it('throws on storage error', async () => {
      const err = { message: 'Not found', code: '404' };
      mockCreateSignedUrl.mockResolvedValueOnce({ data: null, error: err });

      await expect(adminService.getDocumentUrl('bad/path')).rejects.toEqual(err);
    });
  });

  describe('approveDriver', () => {
    it('updates driver status to approved and logs admin action', async () => {
      // First from call: update driver_profiles
      const mockEq1 = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate1 = vi.fn(() => ({ eq: mockEq1 }));

      // Second from call: insert admin_actions
      const mockInsert2 = vi.fn().mockResolvedValue({ error: null });

      mockFrom
        .mockReturnValueOnce({ update: mockUpdate1 })
        .mockReturnValueOnce({ insert: mockInsert2 });

      await adminService.approveDriver('d-1', 'admin-1');

      expect(mockFrom).toHaveBeenNthCalledWith(1, 'driver_profiles');
      expect(mockUpdate1).toHaveBeenCalledWith(expect.objectContaining({
        status: 'approved',
        approved_at: expect.any(String),
      }));
      expect(mockEq1).toHaveBeenCalledWith('id', 'd-1');
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'admin_actions');
      expect(mockInsert2).toHaveBeenCalledWith({
        admin_id: 'admin-1',
        action: 'approve_driver',
        target_type: 'driver_profile',
        target_id: 'd-1',
      });
    });

    it('throws if update fails', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq1 = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate1 = vi.fn(() => ({ eq: mockEq1 }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate1 });

      await expect(adminService.approveDriver('d-1', 'admin-1')).rejects.toEqual(err);
    });
  });

  describe('rejectDriver', () => {
    it('updates driver status to rejected and logs admin action with reason', async () => {
      const mockEq1 = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate1 = vi.fn(() => ({ eq: mockEq1 }));

      const mockInsert2 = vi.fn().mockResolvedValue({ error: null });

      mockFrom
        .mockReturnValueOnce({ update: mockUpdate1 })
        .mockReturnValueOnce({ insert: mockInsert2 });

      await adminService.rejectDriver('d-1', 'admin-1', 'Invalid documents');

      expect(mockFrom).toHaveBeenNthCalledWith(1, 'driver_profiles');
      expect(mockUpdate1).toHaveBeenCalledWith({ status: 'rejected' });
      expect(mockEq1).toHaveBeenCalledWith('id', 'd-1');
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'admin_actions');
      expect(mockInsert2).toHaveBeenCalledWith({
        admin_id: 'admin-1',
        action: 'reject_driver',
        target_type: 'driver_profile',
        target_id: 'd-1',
        reason: 'Invalid documents',
      });
    });

    it('throws if update fails', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq1 = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate1 = vi.fn(() => ({ eq: mockEq1 }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate1 });

      await expect(adminService.rejectDriver('d-1', 'admin-1', 'Bad docs')).rejects.toEqual(err);
    });
  });

  describe('suspendDriver', () => {
    it('updates driver to suspended with reason and logs admin action', async () => {
      const mockEq1 = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate1 = vi.fn(() => ({ eq: mockEq1 }));

      const mockInsert2 = vi.fn().mockResolvedValue({ error: null });

      mockFrom
        .mockReturnValueOnce({ update: mockUpdate1 })
        .mockReturnValueOnce({ insert: mockInsert2 });

      await adminService.suspendDriver('d-1', 'admin-1', 'Fraud detected');

      expect(mockFrom).toHaveBeenNthCalledWith(1, 'driver_profiles');
      expect(mockUpdate1).toHaveBeenCalledWith(expect.objectContaining({
        status: 'suspended',
        is_online: false,
        suspended_at: expect.any(String),
        suspended_reason: 'Fraud detected',
      }));
      expect(mockEq1).toHaveBeenCalledWith('id', 'd-1');
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'admin_actions');
      expect(mockInsert2).toHaveBeenCalledWith({
        admin_id: 'admin-1',
        action: 'suspend_driver',
        target_type: 'driver_profile',
        target_id: 'd-1',
        reason: 'Fraud detected',
      });
    });

    it('throws if update fails', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq1 = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate1 = vi.fn(() => ({ eq: mockEq1 }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate1 });

      await expect(adminService.suspendDriver('d-1', 'admin-1', 'Fraud')).rejects.toEqual(err);
    });
  });

  // ==================== Users ====================
  describe('getUsers', () => {
    it('returns paginated users without filters', async () => {
      const users = [{ id: 'u-1', full_name: 'Juan' }];
      const mockRange = vi.fn().mockResolvedValue({ data: users, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getUsers(0, 20);

      expect(mockFrom).toHaveBeenCalledWith('users');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockRange).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(users);
    });

    it('applies role filter via eq', async () => {
      const users = [{ id: 'u-1', role: 'customer' }];
      const mockEq = vi.fn().mockResolvedValue({ data: users, error: null });
      const mockRange = vi.fn(() => ({ eq: mockEq }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getUsers(0, 20, { role: 'customer' });

      expect(mockEq).toHaveBeenCalledWith('role', 'customer');
      expect(result).toEqual(users);
    });

    it('applies search filter via or (name/phone)', async () => {
      const users = [{ id: 'u-1', full_name: 'Maria' }];
      const mockOr = vi.fn().mockResolvedValue({ data: users, error: null });
      const mockRange = vi.fn(() => ({ or: mockOr }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getUsers(0, 20, { search: 'Maria' });

      expect(mockOr).toHaveBeenCalledWith('full_name.ilike.%Maria%,phone.ilike.%Maria%');
      expect(result).toEqual(users);
    });

    it('applies date range filters', async () => {
      const users = [{ id: 'u-1' }];
      const mockLt = vi.fn().mockResolvedValue({ data: users, error: null });
      const mockGte = vi.fn(() => ({ lt: mockLt }));
      const mockRange = vi.fn(() => ({ gte: mockGte }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getUsers(0, 20, { dateFrom: '2026-01-01', dateTo: '2026-01-31' });

      expect(mockGte).toHaveBeenCalledWith('created_at', '2026-01-01');
      expect(mockLt).toHaveBeenCalledWith('created_at', '2026-01-31T23:59:59');
      expect(result).toEqual(users);
    });

    it('applies isActive filter', async () => {
      const users = [{ id: 'u-1', is_active: true }];
      const mockEq = vi.fn().mockResolvedValue({ data: users, error: null });
      const mockRange = vi.fn(() => ({ eq: mockEq }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getUsers(0, 20, { isActive: true });

      expect(mockEq).toHaveBeenCalledWith('is_active', true);
      expect(result).toEqual(users);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getUsers()).rejects.toEqual(err);
    });
  });

  describe('getUserDetail', () => {
    it('returns user detail with wallet, transfers, and penalties', async () => {
      const user = { id: 'u-1', full_name: 'Maria', level: 'bronce' };
      const wallet = { id: 'w-1', balance: 5000, held_balance: 0, is_active: true };
      const transfers = [{ id: 't-1', amount: 1000 }];
      const penalties = [{ id: 'p-1', amount: 500 }];

      // Query 1: users -> select -> eq -> single
      const mockSingle1 = vi.fn().mockResolvedValue({ data: user, error: null });
      const mockEq1 = vi.fn(() => ({ single: mockSingle1 }));
      const mockSelect1 = vi.fn(() => ({ eq: mockEq1 }));

      // Query 2: wallet_accounts -> select -> eq(user_id) -> eq(account_type) -> maybeSingle
      const mockMaybeSingle2 = vi.fn().mockResolvedValue({ data: wallet, error: null });
      const mockEqType = vi.fn(() => ({ maybeSingle: mockMaybeSingle2 }));
      const mockEqUser2 = vi.fn(() => ({ eq: mockEqType }));
      const mockSelect2 = vi.fn(() => ({ eq: mockEqUser2 }));

      // Query 3: wallet_transfers -> select -> or -> order -> limit
      const mockLimit3 = vi.fn().mockResolvedValue({ data: transfers, error: null });
      const mockOrder3 = vi.fn(() => ({ limit: mockLimit3 }));
      const mockOr = vi.fn(() => ({ order: mockOrder3 }));
      const mockSelect3 = vi.fn(() => ({ or: mockOr }));

      // Query 4: cancellation_penalties -> select -> eq -> order -> limit
      const mockLimit4 = vi.fn().mockResolvedValue({ data: penalties, error: null });
      const mockOrder4 = vi.fn(() => ({ limit: mockLimit4 }));
      const mockEq4 = vi.fn(() => ({ order: mockOrder4 }));
      const mockSelect4 = vi.fn(() => ({ eq: mockEq4 }));

      mockFrom
        .mockReturnValueOnce({ select: mockSelect1 })
        .mockReturnValueOnce({ select: mockSelect2 })
        .mockReturnValueOnce({ select: mockSelect3 })
        .mockReturnValueOnce({ select: mockSelect4 });

      const result = await adminService.getUserDetail('u-1');

      expect(result.user).toEqual(user);
      expect(result.wallet).toEqual(wallet);
      expect(result.transfers).toEqual(transfers);
      expect(result.penalties).toEqual(penalties);
    });

    it('throws when user query errors', async () => {
      const err = { message: 'Not found', code: 'PGRST116' };

      const mockSingle1 = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq1 = vi.fn(() => ({ single: mockSingle1 }));
      const mockSelect1 = vi.fn(() => ({ eq: mockEq1 }));

      const mockMaybeSingle2 = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockEqType = vi.fn(() => ({ maybeSingle: mockMaybeSingle2 }));
      const mockEqUser2 = vi.fn(() => ({ eq: mockEqType }));
      const mockSelect2 = vi.fn(() => ({ eq: mockEqUser2 }));

      const mockLimit3 = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder3 = vi.fn(() => ({ limit: mockLimit3 }));
      const mockOr = vi.fn(() => ({ order: mockOrder3 }));
      const mockSelect3 = vi.fn(() => ({ or: mockOr }));

      const mockLimit4 = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockOrder4 = vi.fn(() => ({ limit: mockLimit4 }));
      const mockEq4 = vi.fn(() => ({ order: mockOrder4 }));
      const mockSelect4 = vi.fn(() => ({ eq: mockEq4 }));

      mockFrom
        .mockReturnValueOnce({ select: mockSelect1 })
        .mockReturnValueOnce({ select: mockSelect2 })
        .mockReturnValueOnce({ select: mockSelect3 })
        .mockReturnValueOnce({ select: mockSelect4 });

      await expect(adminService.getUserDetail('u-1')).rejects.toEqual(err);
    });
  });

  describe('updateUserLevel', () => {
    it('updates user level', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await adminService.updateUserLevel('u-1', 'oro');

      expect(mockFrom).toHaveBeenCalledWith('users');
      expect(mockUpdate).toHaveBeenCalledWith({ level: 'oro' });
      expect(mockEq).toHaveBeenCalledWith('id', 'u-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(adminService.updateUserLevel('u-1', 'plata')).rejects.toEqual(err);
    });
  });

  // ==================== Rides ====================
  describe('getRides', () => {
    it('returns rides without filter', async () => {
      const rides = [{ id: 'r-1', status: 'completed' }];
      const mockEq = vi.fn().mockResolvedValue({ data: rides, error: null });
      const mockRange = vi.fn().mockResolvedValue({ data: rides, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange, eq: mockEq }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getRides({});

      expect(mockFrom).toHaveBeenCalledWith('rides');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockRange).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(rides);
    });

    it('returns rides with status filter', async () => {
      const rides = [{ id: 'r-1', status: 'in_progress' }];
      const mockEqFinal = vi.fn().mockResolvedValue({ data: rides, error: null });
      const mockRange = vi.fn(() => ({ eq: mockEqFinal }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getRides({ status: 'in_progress' });

      expect(mockEqFinal).toHaveBeenCalledWith('status', 'in_progress');
      expect(result).toEqual(rides);
    });

    it('applies serviceType filter', async () => {
      const rides = [{ id: 'r-1', service_type: 'moto_standard' }];
      const mockEqService = vi.fn().mockResolvedValue({ data: rides, error: null });
      const mockRange = vi.fn(() => ({ eq: mockEqService }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getRides({ serviceType: 'moto_standard' });

      expect(mockEqService).toHaveBeenCalledWith('service_type', 'moto_standard');
      expect(result).toEqual(rides);
    });

    it('applies paymentMethod filter', async () => {
      const rides = [{ id: 'r-1', payment_method: 'cash' }];
      const mockEqPayment = vi.fn().mockResolvedValue({ data: rides, error: null });
      const mockRange = vi.fn(() => ({ eq: mockEqPayment }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getRides({ paymentMethod: 'cash' });

      expect(mockEqPayment).toHaveBeenCalledWith('payment_method', 'cash');
      expect(result).toEqual(rides);
    });

    it('applies search filter via or (address)', async () => {
      const rides = [{ id: 'r-1' }];
      const mockOr = vi.fn().mockResolvedValue({ data: rides, error: null });
      const mockRange = vi.fn(() => ({ or: mockOr }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getRides({ search: 'Vedado' });

      expect(mockOr).toHaveBeenCalledWith('pickup_address.ilike.%Vedado%,dropoff_address.ilike.%Vedado%');
      expect(result).toEqual(rides);
    });

    it('applies date range filters', async () => {
      const rides = [{ id: 'r-1' }];
      const mockLt = vi.fn().mockResolvedValue({ data: rides, error: null });
      const mockGte = vi.fn(() => ({ lt: mockLt }));
      const mockRange = vi.fn(() => ({ gte: mockGte }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getRides({ dateFrom: '2026-01-01', dateTo: '2026-01-31' });

      expect(mockGte).toHaveBeenCalledWith('created_at', '2026-01-01');
      expect(mockLt).toHaveBeenCalledWith('created_at', '2026-01-31T23:59:59');
      expect(result).toEqual(rides);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getRides()).rejects.toEqual(err);
    });
  });

  describe('getRideDetail', () => {
    it('returns ride detail with driver info when driver_id exists', async () => {
      const ride = { id: 'r-1', driver_id: 'd-1', customer_id: 'u-1' };
      const transitions = [{ id: 'rt-1', status: 'accepted' }];
      const pricing = { id: 'rps-1', base_fare: 3000 };

      // Query 1: rides -> select -> eq -> single
      const mockSingle1 = vi.fn().mockResolvedValue({ data: ride, error: null });
      const mockEq1 = vi.fn(() => ({ single: mockSingle1 }));
      const mockSelect1 = vi.fn(() => ({ eq: mockEq1 }));

      // Query 2: ride_transitions -> select -> eq -> order
      const mockOrder2 = vi.fn().mockResolvedValue({ data: transitions, error: null });
      const mockEq2 = vi.fn(() => ({ order: mockOrder2 }));
      const mockSelect2 = vi.fn(() => ({ eq: mockEq2 }));

      // Query 3: ride_pricing_snapshots -> select -> eq -> order -> limit -> maybeSingle
      const mockMaybeSingle3 = vi.fn().mockResolvedValue({ data: pricing, error: null });
      const mockLimit3 = vi.fn(() => ({ maybeSingle: mockMaybeSingle3 }));
      const mockOrder3 = vi.fn(() => ({ limit: mockLimit3 }));
      const mockEq3 = vi.fn(() => ({ order: mockOrder3 }));
      const mockSelect3 = vi.fn(() => ({ eq: mockEq3 }));

      // Query 4 (driver): driver_profiles -> select('user_id') -> eq -> single
      const mockSingle4 = vi.fn().mockResolvedValue({ data: { user_id: 'u-driver' }, error: null });
      const mockEq4 = vi.fn(() => ({ single: mockSingle4 }));
      const mockSelect4 = vi.fn(() => ({ eq: mockEq4 }));

      // Query 5 (driver user): users -> select('full_name, phone') -> eq -> single
      const mockSingle5 = vi.fn().mockResolvedValue({ data: { full_name: 'Carlos', phone: '555-1' }, error: null });
      const mockEq5 = vi.fn(() => ({ single: mockSingle5 }));
      const mockSelect5 = vi.fn(() => ({ eq: mockEq5 }));

      // Query 6 (customer): users -> select('full_name, phone') -> eq -> single
      const mockSingle6 = vi.fn().mockResolvedValue({ data: { full_name: 'Maria', phone: '555-2' }, error: null });
      const mockEq6 = vi.fn(() => ({ single: mockSingle6 }));
      const mockSelect6 = vi.fn(() => ({ eq: mockEq6 }));

      mockFrom
        .mockReturnValueOnce({ select: mockSelect1 }) // rides
        .mockReturnValueOnce({ select: mockSelect2 }) // ride_transitions
        .mockReturnValueOnce({ select: mockSelect3 }) // ride_pricing_snapshots
        .mockReturnValueOnce({ select: mockSelect4 }) // driver_profiles
        .mockReturnValueOnce({ select: mockSelect5 }) // users (driver)
        .mockReturnValueOnce({ select: mockSelect6 }); // users (customer)

      const result = await adminService.getRideDetail('r-1');

      expect(result.ride).toEqual(ride);
      expect(result.transitions).toEqual(transitions);
      expect(result.pricing).toEqual(pricing);
      expect(result.driverInfo).toEqual({ name: 'Carlos', phone: '555-1' });
      expect(result.customerInfo).toEqual({ name: 'Maria', phone: '555-2' });
    });

    it('returns ride detail without driver info when no driver_id', async () => {
      const ride = { id: 'r-2', driver_id: null, customer_id: 'u-2' };
      const transitions: unknown[] = [];
      const pricing = null;

      // Query 1: rides
      const mockSingle1 = vi.fn().mockResolvedValue({ data: ride, error: null });
      const mockEq1 = vi.fn(() => ({ single: mockSingle1 }));
      const mockSelect1 = vi.fn(() => ({ eq: mockEq1 }));

      // Query 2: ride_transitions
      const mockOrder2 = vi.fn().mockResolvedValue({ data: transitions, error: null });
      const mockEq2 = vi.fn(() => ({ order: mockOrder2 }));
      const mockSelect2 = vi.fn(() => ({ eq: mockEq2 }));

      // Query 3: ride_pricing_snapshots
      const mockMaybeSingle3 = vi.fn().mockResolvedValue({ data: pricing, error: null });
      const mockLimit3 = vi.fn(() => ({ maybeSingle: mockMaybeSingle3 }));
      const mockOrder3 = vi.fn(() => ({ limit: mockLimit3 }));
      const mockEq3 = vi.fn(() => ({ order: mockOrder3 }));
      const mockSelect3 = vi.fn(() => ({ eq: mockEq3 }));

      // No driver queries (driver_id is null)
      // Query 4 (customer): users
      const mockSingle4 = vi.fn().mockResolvedValue({ data: { full_name: 'Ana', phone: '555-3' }, error: null });
      const mockEq4 = vi.fn(() => ({ single: mockSingle4 }));
      const mockSelect4 = vi.fn(() => ({ eq: mockEq4 }));

      mockFrom
        .mockReturnValueOnce({ select: mockSelect1 })
        .mockReturnValueOnce({ select: mockSelect2 })
        .mockReturnValueOnce({ select: mockSelect3 })
        .mockReturnValueOnce({ select: mockSelect4 }); // customer only

      const result = await adminService.getRideDetail('r-2');

      expect(result.ride).toEqual(ride);
      expect(result.driverInfo).toBeNull();
      expect(result.customerInfo).toEqual({ name: 'Ana', phone: '555-3' });
    });
  });

  // ==================== Audit ====================
  describe('getAuditLog', () => {
    it('returns paginated audit log entries', async () => {
      const logs = [{ id: 'al-1', action: 'login' }];
      const mockRange = vi.fn().mockResolvedValue({ data: logs, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getAuditLog(0, 50);

      expect(mockFrom).toHaveBeenCalledWith('audit_log');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockRange).toHaveBeenCalledWith(0, 49);
      expect(result).toEqual(logs);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getAuditLog()).rejects.toEqual(err);
    });
  });

  describe('getAdminActions', () => {
    it('returns admin actions without date filters', async () => {
      const actions = [{ id: 'aa-1', action: 'approve_driver' }];
      const mockRange = vi.fn().mockResolvedValue({ data: actions, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getAdminActions(0, 50, {});

      expect(mockFrom).toHaveBeenCalledWith('admin_actions');
      expect(mockRange).toHaveBeenCalledWith(0, 49);
      expect(result).toEqual(actions);
    });

    it('applies date range filters when provided', async () => {
      const actions = [{ id: 'aa-1', action: 'approve_driver' }];
      const mockRange = vi.fn().mockResolvedValue({ data: actions, error: null });
      const mockLt = vi.fn(() => ({ range: mockRange }));
      const mockGte = vi.fn(() => ({ lt: mockLt }));
      const mockOrder = vi.fn(() => ({ gte: mockGte }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getAdminActions(0, 50, {
        dateFrom: '2026-03-01',
        dateTo: '2026-03-10',
      });

      expect(mockGte).toHaveBeenCalledWith('created_at', '2026-03-01');
      expect(mockLt).toHaveBeenCalledWith('created_at', '2026-03-11');
      expect(result).toEqual(actions);
    });
  });

  // ==================== Wallet ====================
  describe('getWalletStats', () => {
    it('returns wallet stats from rpc', async () => {
      const stats = { total_in_circulation: 100000, pending_redemptions_count: 5, pending_redemptions_amount: 25000 };
      mockRpc.mockResolvedValueOnce({ data: [stats], error: null });

      const result = await adminService.getWalletStats();

      expect(mockRpc).toHaveBeenCalledWith('get_admin_wallet_stats');
      expect(result).toEqual(stats);
    });

    it('throws on rpc error', async () => {
      const err = { message: 'RPC failed', code: '500' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(adminService.getWalletStats()).rejects.toEqual(err);
    });
  });

  describe('getPendingRedemptions', () => {
    it('returns pending redemptions with driver names', async () => {
      const rawData = [
        {
          id: 'wr-1',
          amount: 5000,
          status: 'requested',
          driver_profiles: { users: { full_name: 'Carlos' } },
        },
      ];
      const mockRange = vi.fn().mockResolvedValue({ data: rawData, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getPendingRedemptions();

      expect(mockFrom).toHaveBeenCalledWith('wallet_redemptions');
      expect(mockEq).toHaveBeenCalledWith('status', 'requested');
      expect(result[0]!.driver_name).toBe('Carlos');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getPendingRedemptions()).rejects.toEqual(err);
    });
  });

  describe('processRedemption', () => {
    it('approves a redemption and logs admin action', async () => {
      // First from call: update wallet_redemptions -> eq(id) -> eq(status)
      const mockEqStatus = vi.fn().mockResolvedValue({ error: null });
      const mockEqId = vi.fn(() => ({ eq: mockEqStatus }));
      const mockUpdate = vi.fn(() => ({ eq: mockEqId }));

      // Second from call: insert admin_actions
      const mockInsert = vi.fn().mockResolvedValue({ error: null });

      mockFrom
        .mockReturnValueOnce({ update: mockUpdate })
        .mockReturnValueOnce({ insert: mockInsert });

      await adminService.processRedemption('wr-1', 'admin-1', 'approved');

      expect(mockFrom).toHaveBeenNthCalledWith(1, 'wallet_redemptions');
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
        status: 'approved',
        processed_at: expect.any(String),
        processed_by: 'admin-1',
      }));
      expect(mockEqId).toHaveBeenCalledWith('id', 'wr-1');
      expect(mockEqStatus).toHaveBeenCalledWith('status', 'requested');
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'admin_actions');
      expect(mockInsert).toHaveBeenCalledWith({
        admin_id: 'admin-1',
        action: 'approve_redemption',
        target_type: 'wallet_redemption',
        target_id: 'wr-1',
        reason: null,
      });
    });

    it('rejects a redemption with reason', async () => {
      const mockEqStatus = vi.fn().mockResolvedValue({ error: null });
      const mockEqId = vi.fn(() => ({ eq: mockEqStatus }));
      const mockUpdate = vi.fn(() => ({ eq: mockEqId }));

      const mockInsert = vi.fn().mockResolvedValue({ error: null });

      mockFrom
        .mockReturnValueOnce({ update: mockUpdate })
        .mockReturnValueOnce({ insert: mockInsert });

      await adminService.processRedemption('wr-1', 'admin-1', 'rejected', 'Suspicious activity');

      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
        status: 'rejected',
        rejection_reason: 'Suspicious activity',
      }));
      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        action: 'reject_redemption',
        reason: 'Suspicious activity',
      }));
    });
  });

  describe('getAdminTransactions', () => {
    it('returns paginated ledger transactions', async () => {
      const txns = [{ id: 'lt-1', type: 'recharge', amount: 5000 }];
      const mockRange = vi.fn().mockResolvedValue({ data: txns, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getAdminTransactions(0, 20);

      expect(mockFrom).toHaveBeenCalledWith('ledger_transactions');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockRange).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(txns);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getAdminTransactions()).rejects.toEqual(err);
    });
  });

  describe('getPendingRecharges', () => {
    it('returns pending recharges with user names', async () => {
      const rawData = [
        { id: 'rr-1', amount: 10000, status: 'pending', users: { full_name: 'Luis' } },
      ];
      const mockRange = vi.fn().mockResolvedValue({ data: rawData, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getPendingRecharges();

      expect(mockFrom).toHaveBeenCalledWith('wallet_recharge_requests');
      expect(mockSelect).toHaveBeenCalledWith('*, users!inner(full_name)');
      expect(mockEq).toHaveBeenCalledWith('status', 'pending');
      expect(result[0]!.user_name).toBe('Luis');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getPendingRecharges()).rejects.toEqual(err);
    });
  });

  describe('processRecharge', () => {
    it('processes an approved recharge with all ledger steps', async () => {
      const rechargeReq = { id: 'rr-1', user_id: 'u-1', amount: 10000, status: 'pending' };

      // Step 1: from('wallet_recharge_requests').select -> eq(id) -> eq(status) -> single
      const mockSingle1 = vi.fn().mockResolvedValue({ data: rechargeReq, error: null });
      const mockEqStatus1 = vi.fn(() => ({ single: mockSingle1 }));
      const mockEqId1 = vi.fn(() => ({ eq: mockEqStatus1 }));
      const mockSelect1 = vi.fn(() => ({ eq: mockEqId1 }));

      // Step 2: rpc('ensure_wallet_account')
      mockRpc.mockResolvedValueOnce({ data: 'acct-1', error: null });

      // Step 3: from('wallet_accounts').select('balance') -> eq(id) -> single
      const mockSingle3 = vi.fn().mockResolvedValue({ data: { balance: 5000 }, error: null });
      const mockEq3 = vi.fn(() => ({ single: mockSingle3 }));
      const mockSelect3 = vi.fn(() => ({ eq: mockEq3 }));

      // Step 4: from('ledger_transactions').insert -> select('id') -> single
      const mockSingle4 = vi.fn().mockResolvedValue({ data: { id: 'txn-1' }, error: null });
      const mockSelectId4 = vi.fn(() => ({ single: mockSingle4 }));
      const mockInsert4 = vi.fn(() => ({ select: mockSelectId4 }));

      // Step 5: from('ledger_entries').insert
      const mockInsert5 = vi.fn().mockResolvedValue({ error: null });

      // Step 6: from('wallet_accounts').update -> eq
      const mockEq6 = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate6 = vi.fn(() => ({ eq: mockEq6 }));

      // Step 7: from('wallet_recharge_requests').update -> eq
      const mockEq7 = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate7 = vi.fn(() => ({ eq: mockEq7 }));

      // Step 8: from('admin_actions').insert
      const mockInsert8 = vi.fn().mockResolvedValue({ error: null });

      mockFrom
        .mockReturnValueOnce({ select: mockSelect1 })   // wallet_recharge_requests.select
        .mockReturnValueOnce({ select: mockSelect3 })   // wallet_accounts.select
        .mockReturnValueOnce({ insert: mockInsert4 })    // ledger_transactions.insert
        .mockReturnValueOnce({ insert: mockInsert5 })    // ledger_entries.insert
        .mockReturnValueOnce({ update: mockUpdate6 })    // wallet_accounts.update
        .mockReturnValueOnce({ update: mockUpdate7 })    // wallet_recharge_requests.update
        .mockReturnValueOnce({ insert: mockInsert8 });   // admin_actions.insert

      await adminService.processRecharge('rr-1', 'admin-1', true);

      expect(mockRpc).toHaveBeenCalledWith('ensure_wallet_account', {
        p_user_id: 'u-1',
        p_type: 'customer_cash',
      });
      expect(mockInsert4).toHaveBeenCalledWith(expect.objectContaining({
        idempotency_key: 'recharge:rr-1',
        type: 'recharge',
        status: 'posted',
      }));
      expect(mockInsert5).toHaveBeenCalledWith(expect.objectContaining({
        transaction_id: 'txn-1',
        account_id: 'acct-1',
        amount: 10000,
        balance_after: 15000,
      }));
      expect(mockUpdate6).toHaveBeenCalledWith({ balance: 15000 });
      expect(mockEq6).toHaveBeenCalledWith('id', 'acct-1');
      expect(mockUpdate7).toHaveBeenCalledWith(expect.objectContaining({
        status: 'approved',
        processed_by: 'admin-1',
      }));
      expect(mockInsert8).toHaveBeenCalledWith(expect.objectContaining({
        action: 'approve_recharge',
        target_id: 'rr-1',
      }));
    });

    it('processes a rejected recharge', async () => {
      // Step 1 (rejected path): from('wallet_recharge_requests').update -> eq
      const mockEq1 = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate1 = vi.fn(() => ({ eq: mockEq1 }));

      // Step 2: from('admin_actions').insert
      const mockInsert2 = vi.fn().mockResolvedValue({ error: null });

      mockFrom
        .mockReturnValueOnce({ update: mockUpdate1 })
        .mockReturnValueOnce({ insert: mockInsert2 });

      await adminService.processRecharge('rr-1', 'admin-1', false, 'Invalid receipt');

      expect(mockUpdate1).toHaveBeenCalledWith(expect.objectContaining({
        status: 'rejected',
        processed_by: 'admin-1',
        rejection_reason: 'Invalid receipt',
      }));
      expect(mockEq1).toHaveBeenCalledWith('id', 'rr-1');
      expect(mockInsert2).toHaveBeenCalledWith(expect.objectContaining({
        action: 'reject_recharge',
        reason: 'Invalid receipt',
      }));
    });
  });

  // ==================== Service Types ====================
  describe('getServiceTypeConfigs', () => {
    it('returns service type configs ordered by slug', async () => {
      const configs = [{ id: 'stc-1', slug: 'moto', name_es: 'Moto' }];
      const mockOrder = vi.fn().mockResolvedValue({ data: configs, error: null });
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getServiceTypeConfigs();

      expect(mockFrom).toHaveBeenCalledWith('service_type_configs');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockOrder).toHaveBeenCalledWith('slug');
      expect(result).toEqual(configs);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getServiceTypeConfigs()).rejects.toEqual(err);
    });
  });

  describe('updateServiceTypeConfig', () => {
    it('updates service type config with updated_at', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await adminService.updateServiceTypeConfig('stc-1', { base_fare_cup: 5000 });

      expect(mockFrom).toHaveBeenCalledWith('service_type_configs');
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
        base_fare_cup: 5000,
        updated_at: expect.any(String),
      }));
      expect(mockEq).toHaveBeenCalledWith('id', 'stc-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(adminService.updateServiceTypeConfig('stc-1', {})).rejects.toEqual(err);
    });
  });

  // ==================== Pricing Rules ====================
  describe('getPricingRules', () => {
    it('returns paginated pricing rules ordered by service_type', async () => {
      const rules = [{ id: 'pr-1', service_type: 'moto', base_fare_cup: 3000 }];
      const mockRange = vi.fn().mockResolvedValue({ data: rules, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getPricingRules(0, 20);

      expect(mockFrom).toHaveBeenCalledWith('pricing_rules');
      expect(mockOrder).toHaveBeenCalledWith('service_type');
      expect(mockRange).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(rules);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getPricingRules()).rejects.toEqual(err);
    });
  });

  describe('updatePricingRule', () => {
    it('updates pricing rule with updated_at', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await adminService.updatePricingRule('pr-1', { base_fare_cup: 4000 });

      expect(mockFrom).toHaveBeenCalledWith('pricing_rules');
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
        base_fare_cup: 4000,
        updated_at: expect.any(String),
      }));
      expect(mockEq).toHaveBeenCalledWith('id', 'pr-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(adminService.updatePricingRule('pr-1', {})).rejects.toEqual(err);
    });
  });

  describe('createPricingRule', () => {
    it('inserts a new pricing rule', async () => {
      const rule = {
        service_type: 'moto',
        base_fare_cup: 3000,
        per_km_rate_cup: 500,
        per_minute_rate_cup: 100,
        min_fare_cup: 2000,
      };
      const mockInsert = vi.fn().mockResolvedValue({ error: null });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await adminService.createPricingRule(rule as any);

      expect(mockFrom).toHaveBeenCalledWith('pricing_rules');
      expect(mockInsert).toHaveBeenCalledWith(rule);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockInsert = vi.fn().mockResolvedValue({ error: err });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(adminService.createPricingRule({} as any)).rejects.toEqual(err);
    });
  });

  // ==================== Zones ====================
  describe('getZones', () => {
    it('returns zones with selected fields ordered by name', async () => {
      const zones = [{ id: 'z-1', name: 'Centro', type: 'operational' }];
      const mockOrder = vi.fn().mockResolvedValue({ data: zones, error: null });
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getZones();

      expect(mockFrom).toHaveBeenCalledWith('zones');
      expect(mockSelect).toHaveBeenCalledWith('id, name, type, surge_multiplier, is_active, created_at, updated_at');
      expect(mockOrder).toHaveBeenCalledWith('name');
      expect(result).toEqual(zones);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getZones()).rejects.toEqual(err);
    });
  });

  describe('updateZone', () => {
    it('updates zone with updated_at', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await adminService.updateZone('z-1', { surge_multiplier: 1.5 });

      expect(mockFrom).toHaveBeenCalledWith('zones');
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
        surge_multiplier: 1.5,
        updated_at: expect.any(String),
      }));
      expect(mockEq).toHaveBeenCalledWith('id', 'z-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(adminService.updateZone('z-1', {})).rejects.toEqual(err);
    });
  });

  // ==================== Promotions ====================
  describe('getPromotions', () => {
    it('returns paginated promotions', async () => {
      const promos = [{ id: 'p-1', code: 'TRICI10', type: 'percent' }];
      const mockRange = vi.fn().mockResolvedValue({ data: promos, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getPromotions(0, 20);

      expect(mockFrom).toHaveBeenCalledWith('promotions');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockRange).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(promos);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getPromotions()).rejects.toEqual(err);
    });
  });

  describe('createPromotion', () => {
    it('inserts a new promotion with admin id as created_by', async () => {
      const promo = {
        code: 'TRICI20',
        type: 'percent' as const,
        is_active: true,
        valid_from: '2026-03-01',
        discount_percent: 20,
      };
      const mockInsert = vi.fn().mockResolvedValue({ error: null });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await adminService.createPromotion(promo as any, 'admin-1');

      expect(mockFrom).toHaveBeenCalledWith('promotions');
      expect(mockInsert).toHaveBeenCalledWith({ ...promo, created_by: 'admin-1' });
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockInsert = vi.fn().mockResolvedValue({ error: err });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(adminService.createPromotion({} as any, 'admin-1')).rejects.toEqual(err);
    });
  });

  describe('updatePromotion', () => {
    it('updates a promotion', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await adminService.updatePromotion('p-1', { is_active: false });

      expect(mockFrom).toHaveBeenCalledWith('promotions');
      expect(mockUpdate).toHaveBeenCalledWith({ is_active: false });
      expect(mockEq).toHaveBeenCalledWith('id', 'p-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(adminService.updatePromotion('p-1', {})).rejects.toEqual(err);
    });
  });

  describe('deletePromotion', () => {
    it('deletes a promotion with zero current uses', async () => {
      const mockEqUses = vi.fn().mockResolvedValue({ error: null });
      const mockEqId = vi.fn(() => ({ eq: mockEqUses }));
      const mockDelete = vi.fn(() => ({ eq: mockEqId }));

      mockFrom.mockReturnValueOnce({ delete: mockDelete });

      await adminService.deletePromotion('p-1');

      expect(mockFrom).toHaveBeenCalledWith('promotions');
      expect(mockEqId).toHaveBeenCalledWith('id', 'p-1');
      expect(mockEqUses).toHaveBeenCalledWith('current_uses', 0);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Delete failed', code: '42P01' };
      const mockEqUses = vi.fn().mockResolvedValue({ error: err });
      const mockEqId = vi.fn(() => ({ eq: mockEqUses }));
      const mockDelete = vi.fn(() => ({ eq: mockEqId }));

      mockFrom.mockReturnValueOnce({ delete: mockDelete });

      await expect(adminService.deletePromotion('p-1')).rejects.toEqual(err);
    });
  });

  // ==================== Incidents ====================
  describe('getIncidents', () => {
    it('returns incidents without status filter', async () => {
      const incidents = [{ id: 'inc-1', status: 'open' }];
      const mockEq = vi.fn().mockResolvedValue({ data: incidents, error: null });
      const mockRange = vi.fn().mockResolvedValue({ data: incidents, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange, eq: mockEq }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getIncidents(undefined, 0, 20);

      expect(mockFrom).toHaveBeenCalledWith('incident_reports');
      expect(mockRange).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(incidents);
    });

    it('applies status filter when status is not "all"', async () => {
      const incidents = [{ id: 'inc-1', status: 'open' }];
      const mockEqFinal = vi.fn().mockResolvedValue({ data: incidents, error: null });
      const mockRange = vi.fn(() => ({ eq: mockEqFinal }));
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getIncidents('open', 0, 20);

      expect(mockEqFinal).toHaveBeenCalledWith('status', 'open');
      expect(result).toEqual(incidents);
    });
  });

  describe('updateIncidentStatus', () => {
    it('updates incident to resolved and logs admin action', async () => {
      const mockEq1 = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate1 = vi.fn(() => ({ eq: mockEq1 }));

      const mockInsert2 = vi.fn().mockResolvedValue({ error: null });

      mockFrom
        .mockReturnValueOnce({ update: mockUpdate1 })
        .mockReturnValueOnce({ insert: mockInsert2 });

      await adminService.updateIncidentStatus('inc-1', 'resolved', 'admin-1', 'Resolved by phone');

      expect(mockFrom).toHaveBeenNthCalledWith(1, 'incident_reports');
      expect(mockUpdate1).toHaveBeenCalledWith(expect.objectContaining({
        status: 'resolved',
        resolved_at: expect.any(String),
      }));
      expect(mockEq1).toHaveBeenCalledWith('id', 'inc-1');
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'admin_actions');
      expect(mockInsert2).toHaveBeenCalledWith({
        admin_id: 'admin-1',
        action: 'incident_resolved',
        target_type: 'incident_report',
        target_id: 'inc-1',
        reason: 'Resolved by phone',
      });
    });

    it('updates incident to investigating with null resolved_at', async () => {
      const mockEq1 = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate1 = vi.fn(() => ({ eq: mockEq1 }));

      const mockInsert2 = vi.fn().mockResolvedValue({ error: null });

      mockFrom
        .mockReturnValueOnce({ update: mockUpdate1 })
        .mockReturnValueOnce({ insert: mockInsert2 });

      await adminService.updateIncidentStatus('inc-1', 'investigating', 'admin-1');

      expect(mockUpdate1).toHaveBeenCalledWith({
        status: 'investigating',
        resolved_at: null,
      });
      expect(mockInsert2).toHaveBeenCalledWith({
        admin_id: 'admin-1',
        action: 'incident_investigating',
        target_type: 'incident_report',
        target_id: 'inc-1',
        reason: null,
      });
    });
  });

  // ==================== Feature Flags ====================
  describe('getFeatureFlags', () => {
    it('returns feature flags ordered by key', async () => {
      const flags = [{ id: 'ff-1', key: 'dark_mode', value: true }];
      const mockOrder = vi.fn().mockResolvedValue({ data: flags, error: null });
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getFeatureFlags();

      expect(mockFrom).toHaveBeenCalledWith('feature_flags');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockOrder).toHaveBeenCalledWith('key');
      expect(result).toEqual(flags);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getFeatureFlags()).rejects.toEqual(err);
    });
  });

  describe('updateFeatureFlag', () => {
    it('updates feature flag', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await adminService.updateFeatureFlag('ff-1', { value: false });

      expect(mockFrom).toHaveBeenCalledWith('feature_flags');
      expect(mockUpdate).toHaveBeenCalledWith({ value: false });
      expect(mockEq).toHaveBeenCalledWith('id', 'ff-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(adminService.updateFeatureFlag('ff-1', {})).rejects.toEqual(err);
    });
  });

  describe('createFeatureFlag', () => {
    it('inserts a new feature flag', async () => {
      const flag = { key: 'new_feature', value: true, description: 'A new feature' };
      const mockInsert = vi.fn().mockResolvedValue({ error: null });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await adminService.createFeatureFlag(flag as any);

      expect(mockFrom).toHaveBeenCalledWith('feature_flags');
      expect(mockInsert).toHaveBeenCalledWith(flag);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockInsert = vi.fn().mockResolvedValue({ error: err });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(adminService.createFeatureFlag({} as any)).rejects.toEqual(err);
    });
  });

  // ==================== Surge Zones ====================
  describe('getSurgeZones', () => {
    it('returns surge zones ordered by created_at desc', async () => {
      const surges = [{ id: 'sz-1', multiplier: 1.5, active: true }];
      const mockOrder = vi.fn().mockResolvedValue({ data: surges, error: null });
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await adminService.getSurgeZones();

      expect(mockFrom).toHaveBeenCalledWith('surge_zones');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(result).toEqual(surges);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ order: mockOrder }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(adminService.getSurgeZones()).rejects.toEqual(err);
    });
  });

  describe('createSurgeZone', () => {
    it('inserts a new surge zone with defaults', async () => {
      const mockInsert = vi.fn().mockResolvedValue({ error: null });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await adminService.createSurgeZone({ zone_id: 'z-1', multiplier: 2.0 });

      expect(mockFrom).toHaveBeenCalledWith('surge_zones');
      expect(mockInsert).toHaveBeenCalledWith({
        zone_id: 'z-1',
        multiplier: 2.0,
        reason: null,
        active: true,
        starts_at: null,
        ends_at: null,
      });
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockInsert = vi.fn().mockResolvedValue({ error: err });

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(adminService.createSurgeZone({ zone_id: null, multiplier: 1.5 })).rejects.toEqual(err);
    });
  });

  describe('updateSurgeZone', () => {
    it('updates a surge zone', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await adminService.updateSurgeZone('sz-1', { multiplier: 1.8, active: false });

      expect(mockFrom).toHaveBeenCalledWith('surge_zones');
      expect(mockUpdate).toHaveBeenCalledWith({ multiplier: 1.8, active: false });
      expect(mockEq).toHaveBeenCalledWith('id', 'sz-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(adminService.updateSurgeZone('sz-1', {})).rejects.toEqual(err);
    });
  });

  describe('deleteSurgeZone', () => {
    it('deletes a surge zone', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockDelete = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ delete: mockDelete });

      await adminService.deleteSurgeZone('sz-1');

      expect(mockFrom).toHaveBeenCalledWith('surge_zones');
      expect(mockEq).toHaveBeenCalledWith('id', 'sz-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Delete failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockDelete = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ delete: mockDelete });

      await expect(adminService.deleteSurgeZone('sz-1')).rejects.toEqual(err);
    });
  });

  // ==================== Driver Score ====================
  describe('adjustDriverScore', () => {
    it('calls rpc and returns new score', async () => {
      mockRpc.mockResolvedValueOnce({ data: 65.5, error: null });

      const result = await adminService.adjustDriverScore('d-1', 15.5, 'Good performance');

      expect(mockRpc).toHaveBeenCalledWith('update_driver_score', {
        p_driver_id: 'd-1',
        p_event_type: 'admin_adjustment',
        p_details: { delta: 15.5, reason: 'Good performance' },
      });
      expect(result).toBe(65.5);
    });

    it('throws on rpc error', async () => {
      const err = { message: 'RPC failed', code: '500' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(adminService.adjustDriverScore('d-1', -10)).rejects.toEqual(err);
    });
  });

  // ==================== Analytics ====================
  describe('getRidesByDay', () => {
    it('returns daily ride data from rpc', async () => {
      const days = [{ day: '2026-03-01', total: 10, completed: 8, canceled: 2, revenue: 50000 }];
      mockRpc.mockResolvedValueOnce({ data: days, error: null });

      const result = await adminService.getRidesByDay(7);

      expect(mockRpc).toHaveBeenCalledWith('get_rides_by_day', { p_days_back: 7 });
      expect(result).toEqual(days);
    });

    it('throws on rpc error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'fail' } });
      await expect(adminService.getRidesByDay()).rejects.toEqual({ message: 'fail' });
    });
  });

  describe('getRidesByServiceType', () => {
    it('returns service type breakdown from rpc', async () => {
      const types = [{ service_type: 'triciclo_basico', count: 100, revenue: 500000 }];
      mockRpc.mockResolvedValueOnce({ data: types, error: null });

      const result = await adminService.getRidesByServiceType(30);

      expect(mockRpc).toHaveBeenCalledWith('get_rides_by_service_type', { p_days_back: 30 });
      expect(result).toEqual(types);
    });
  });

  describe('getRidesByPaymentMethod', () => {
    it('returns payment method breakdown from rpc', async () => {
      const methods = [{ payment_method: 'cash', count: 80, revenue: 400000 }];
      mockRpc.mockResolvedValueOnce({ data: methods, error: null });

      const result = await adminService.getRidesByPaymentMethod(30);

      expect(mockRpc).toHaveBeenCalledWith('get_rides_by_payment_method', { p_days_back: 30 });
      expect(result).toEqual(methods);
    });
  });

  describe('getPeakHours', () => {
    it('returns hourly averages from rpc', async () => {
      const hours = [{ hour: 8, avg_rides: 5.2 }, { hour: 18, avg_rides: 7.1 }];
      mockRpc.mockResolvedValueOnce({ data: hours, error: null });

      const result = await adminService.getPeakHours(30);

      expect(mockRpc).toHaveBeenCalledWith('get_peak_hours', { p_days_back: 30 });
      expect(result).toEqual(hours);
    });
  });

  describe('getTopDrivers', () => {
    it('returns top drivers from rpc', async () => {
      const drivers = [{ driver_id: 'd-1', driver_name: 'Juan', rides_count: 50, rating: 4.8, revenue: 250000 }];
      mockRpc.mockResolvedValueOnce({ data: drivers, error: null });

      const result = await adminService.getTopDrivers(5);

      expect(mockRpc).toHaveBeenCalledWith('get_top_drivers', { p_limit: 5 });
      expect(result).toEqual(drivers);
    });
  });

  describe('getDriverUtilization', () => {
    it('returns utilization snapshot from rpc', async () => {
      const util = { online: 15, busy: 8, idle: 7, offline: 30 };
      mockRpc.mockResolvedValueOnce({ data: [util], error: null });

      const result = await adminService.getDriverUtilization();

      expect(mockRpc).toHaveBeenCalledWith('get_driver_utilization');
      expect(result).toEqual(util);
    });

    it('returns defaults when data is null', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      const result = await adminService.getDriverUtilization();

      expect(result).toEqual({ online: 0, busy: 0, idle: 0, offline: 0 });
    });
  });
});
