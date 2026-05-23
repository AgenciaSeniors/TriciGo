import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockQueryChain } from './helpers/mockSupabase';

// Mock the Supabase client — default to a full chainable
const mockFrom = vi.fn(() => createMockQueryChain());
const mockRpc = vi.fn();
const mockCreateSignedUrl = vi.fn();
const mockStorage = { from: vi.fn(() => ({ createSignedUrl: mockCreateSignedUrl })) };
const mockSupabase = { from: mockFrom, rpc: mockRpc, storage: mockStorage };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Mock notification service (used by approve/reject/suspend)
vi.mock('../notification.service', () => ({
  notificationService: {
    sendToUser: vi.fn().mockResolvedValue(undefined),
    sendPush: vi.fn(),
    notifyDriver: vi.fn(),
    notifyRider: vi.fn(),
  },
}));

// Import after mock is set up
import { adminService } from '../admin.service';

describe('adminService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default chainable after clearAllMocks
    mockFrom.mockImplementation(() => createMockQueryChain());
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
      const chain = createMockQueryChain({ data: drivers, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getDriversByStatus('approved' as any, 1, 10);

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(chain.select).toHaveBeenCalledWith('*, users!inner(full_name, phone, email), vehicles(type, plate_number)');
      expect(chain.eq).toHaveBeenCalledWith('status', 'approved');
      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(chain.range).toHaveBeenCalledWith(10, 19);
      expect(result).toEqual(drivers);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getDriversByStatus('pending_verification' as any)).rejects.toEqual(err);
    });
  });

  describe('getAllDrivers', () => {
    it('returns all drivers with default pagination', async () => {
      const drivers = [{ id: 'd-1' }, { id: 'd-2' }];
      const chain = createMockQueryChain({ data: drivers, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getAllDrivers();

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(chain.select).toHaveBeenCalledWith('*, users!inner(full_name, phone, email), vehicles(type, plate_number)');
      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(chain.range).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(drivers);
    });

    it('applies status filter', async () => {
      const drivers = [{ id: 'd-1', status: 'approved' }];
      const chain = createMockQueryChain({ data: drivers, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getAllDrivers(0, 20, { status: 'approved' });

      expect(chain.eq).toHaveBeenCalledWith('status', 'approved');
      expect(result).toEqual(drivers);
    });

    it('applies search filter via ilike on users.full_name', async () => {
      const drivers = [{ id: 'd-1', users: { full_name: 'Carlos' } }];
      const chain = createMockQueryChain({ data: drivers, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getAllDrivers(0, 20, { search: 'Carlos' });

      expect(chain.ilike).toHaveBeenCalledWith('users.full_name', '%Carlos%');
      expect(result).toEqual(drivers);
    });

    it('applies rating filter via gte', async () => {
      const drivers = [{ id: 'd-1', rating_avg: 4.5 }];
      const chain = createMockQueryChain({ data: drivers, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getAllDrivers(0, 20, { ratingMin: 4.0 });

      expect(chain.gte).toHaveBeenCalledWith('rating_avg', 4.0);
      expect(result).toEqual(drivers);
    });

    it('filters by vehicle type client-side', async () => {
      const drivers = [
        { id: 'd-1', vehicles: [{ type: 'moto', plate_number: 'M1' }] },
        { id: 'd-2', vehicles: [{ type: 'auto', plate_number: 'A1' }] },
      ];
      const chain = createMockQueryChain({ data: drivers, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getAllDrivers(0, 20, { vehicleType: 'moto' });

      expect(result).toEqual([drivers[0]]);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getAllDrivers()).rejects.toEqual(err);
    });
  });

  describe('getDriverDetail', () => {
    it('returns driver detail with profile, vehicle, documents, and score events', async () => {
      const profile = { id: 'd-1', users: { full_name: 'Juan', phone: '555', email: 'j@t.co' } };
      const vehicles = [{ id: 'v-1', type: 'moto' }];
      const documents = [{ id: 'doc-1', document_type: 'license' }];
      const scoreEvents = [{ id: 'se-1', event_type: 'ride_completed' }];

      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: profile, error: null });

      const chain2 = createMockQueryChain({ data: vehicles, error: null });
      const chain3 = createMockQueryChain({ data: documents, error: null });
      const chain4 = createMockQueryChain({ data: scoreEvents, error: null });

      mockFrom
        .mockReturnValueOnce(chain1)   // driver_profiles
        .mockReturnValueOnce(chain2)   // vehicles
        .mockReturnValueOnce(chain3)   // driver_documents
        .mockReturnValueOnce(chain4);  // driver_score_events

      const result = await adminService.getDriverDetail('d-1');

      expect(result.profile).toEqual(profile);
      expect(result.vehicle).toEqual(vehicles[0]);
      expect(result.documents).toEqual(documents);
      expect(result.scoreEvents).toEqual(scoreEvents);
    });

    it('throws when profile query errors', async () => {
      const err = { message: 'Not found', code: 'PGRST116' };
      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: null, error: err });

      mockFrom.mockReturnValueOnce(chain1);
      // Remaining chains use default (from mockImplementation)

      await expect(adminService.getDriverDetail('d-1')).rejects.toEqual(err);
    });

    it('returns null vehicle when no active vehicle exists', async () => {
      const profile = { id: 'd-1', users: { full_name: 'Juan', phone: '555', email: null } };

      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: profile, error: null });

      const chain2 = createMockQueryChain({ data: [], error: null });
      const chain3 = createMockQueryChain({ data: [], error: null });
      const chain4 = createMockQueryChain({ data: [], error: null });

      mockFrom
        .mockReturnValueOnce(chain1)
        .mockReturnValueOnce(chain2)
        .mockReturnValueOnce(chain3)
        .mockReturnValueOnce(chain4);

      const result = await adminService.getDriverDetail('d-1');

      expect(result.vehicle).toBeNull();
    });

    it('returns empty arrays when documents and score events are null', async () => {
      const profile = { id: 'd-1', users: { full_name: 'Juan', phone: '555', email: null } };

      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: profile, error: null });

      const chain2 = createMockQueryChain({ data: null, error: null });
      const chain3 = createMockQueryChain({ data: null, error: null });
      const chain4 = createMockQueryChain({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(chain1)
        .mockReturnValueOnce(chain2)
        .mockReturnValueOnce(chain3)
        .mockReturnValueOnce(chain4);

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
      const updateChain = createMockQueryChain({ data: null, error: null });
      const insertChain = createMockQueryChain({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(updateChain)   // driver_profiles.update
        .mockReturnValueOnce(insertChain);  // admin_actions.insert
      // 3rd call (driver_profiles.select for notification) uses default chain

      await adminService.approveDriver('d-1', 'admin-1');

      expect(mockFrom).toHaveBeenNthCalledWith(1, 'driver_profiles');
      expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'approved',
        approved_at: expect.any(String),
      }));
      expect(updateChain.eq).toHaveBeenCalledWith('id', 'd-1');
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'admin_actions');
      expect(insertChain.insert).toHaveBeenCalledWith({
        admin_id: 'admin-1',
        action: 'approve_driver',
        target_type: 'driver_profile',
        target_id: 'd-1',
      });
    });

    it('throws if update fails', async () => {
      const chain = createMockQueryChain({ data: null, error: { message: 'Update failed', code: '42P01' } });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.approveDriver('d-1', 'admin-1')).rejects.toEqual({ message: 'Update failed', code: '42P01' });
    });
  });

  describe('rejectDriver', () => {
    it('updates driver status to rejected and logs admin action with reason', async () => {
      const updateChain = createMockQueryChain({ data: null, error: null });
      const insertChain = createMockQueryChain({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(updateChain)
        .mockReturnValueOnce(insertChain);

      await adminService.rejectDriver('d-1', 'admin-1', 'Invalid documents');

      expect(mockFrom).toHaveBeenNthCalledWith(1, 'driver_profiles');
      expect(updateChain.update).toHaveBeenCalledWith({ status: 'rejected' });
      expect(updateChain.eq).toHaveBeenCalledWith('id', 'd-1');
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'admin_actions');
      expect(insertChain.insert).toHaveBeenCalledWith({
        admin_id: 'admin-1',
        action: 'reject_driver',
        target_type: 'driver_profile',
        target_id: 'd-1',
        reason: 'Invalid documents',
      });
    });

    it('throws if update fails', async () => {
      const chain = createMockQueryChain({ data: null, error: { message: 'Update failed', code: '42P01' } });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.rejectDriver('d-1', 'admin-1', 'Bad docs')).rejects.toEqual({ message: 'Update failed', code: '42P01' });
    });
  });

  describe('suspendDriver', () => {
    it('updates driver to suspended with reason and logs admin action', async () => {
      const updateChain = createMockQueryChain({ data: null, error: null });
      const insertChain = createMockQueryChain({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(updateChain)
        .mockReturnValueOnce(insertChain);

      await adminService.suspendDriver('d-1', 'admin-1', 'Fraud detected');

      expect(mockFrom).toHaveBeenNthCalledWith(1, 'driver_profiles');
      expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'suspended',
        is_online: false,
        suspended_at: expect.any(String),
        suspended_reason: 'Fraud detected',
      }));
      expect(updateChain.eq).toHaveBeenCalledWith('id', 'd-1');
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'admin_actions');
      expect(insertChain.insert).toHaveBeenCalledWith({
        admin_id: 'admin-1',
        action: 'suspend_driver',
        target_type: 'driver_profile',
        target_id: 'd-1',
        reason: 'Fraud detected',
      });
    });

    it('throws if update fails', async () => {
      const chain = createMockQueryChain({ data: null, error: { message: 'Update failed', code: '42P01' } });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.suspendDriver('d-1', 'admin-1', 'Fraud')).rejects.toEqual({ message: 'Update failed', code: '42P01' });
    });
  });

  // ==================== Users ====================
  describe('getUsers', () => {
    it('returns paginated users without filters', async () => {
      const users = [{ id: 'u-1', full_name: 'Juan' }];
      const chain = createMockQueryChain({ data: users, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getUsers(0, 20);

      expect(mockFrom).toHaveBeenCalledWith('users');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(chain.range).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(users);
    });

    it('applies role filter via eq', async () => {
      const users = [{ id: 'u-1', role: 'customer' }];
      const chain = createMockQueryChain({ data: users, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getUsers(0, 20, { role: 'customer' });

      expect(chain.eq).toHaveBeenCalledWith('role', 'customer');
      expect(result).toEqual(users);
    });

    it('applies search filter via or (name/phone)', async () => {
      const users = [{ id: 'u-1', full_name: 'Maria' }];
      const chain = createMockQueryChain({ data: users, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getUsers(0, 20, { search: 'Maria' });

      expect(chain.or).toHaveBeenCalledWith('full_name.ilike.%Maria%,phone.ilike.%Maria%');
      expect(result).toEqual(users);
    });

    it('applies date range filters', async () => {
      const users = [{ id: 'u-1' }];
      const chain = createMockQueryChain({ data: users, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getUsers(0, 20, { dateFrom: '2026-01-01', dateTo: '2026-01-31' });

      expect(chain.gte).toHaveBeenCalledWith('created_at', '2026-01-01');
      expect(chain.lt).toHaveBeenCalledWith('created_at', '2026-01-31T23:59:59');
      expect(result).toEqual(users);
    });

    it('applies isActive filter', async () => {
      const users = [{ id: 'u-1', is_active: true }];
      const chain = createMockQueryChain({ data: users, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getUsers(0, 20, { isActive: true });

      expect(chain.eq).toHaveBeenCalledWith('is_active', true);
      expect(result).toEqual(users);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getUsers()).rejects.toEqual(err);
    });
  });

  describe('getUserDetail', () => {
    it('returns user detail with wallet, transfers, and penalties', async () => {
      const user = { id: 'u-1', full_name: 'Maria', level: 'bronce' };
      const wallet = { id: 'w-1', balance: 5000, held_balance: 0, is_active: true };
      const transfers = [{ id: 't-1', amount: 1000 }];
      const penalties = [{ id: 'p-1', amount: 500 }];

      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: user, error: null });

      const chain2 = createMockQueryChain();
      chain2.maybeSingle.mockResolvedValue({ data: wallet, error: null });

      const chain3 = createMockQueryChain({ data: transfers, error: null });
      const chain4 = createMockQueryChain({ data: penalties, error: null });

      mockFrom
        .mockReturnValueOnce(chain1)  // users
        .mockReturnValueOnce(chain2)  // wallet_accounts
        .mockReturnValueOnce(chain3)  // wallet_transfers
        .mockReturnValueOnce(chain4); // cancellation_penalties

      const result = await adminService.getUserDetail('u-1');

      expect(result.user).toEqual(user);
      expect(result.wallet).toEqual(wallet);
      expect(result.transfers).toEqual(transfers);
      expect(result.penalties).toEqual(penalties);
    });

    it('throws when user query errors', async () => {
      const err = { message: 'Not found', code: 'PGRST116' };

      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: null, error: err });

      mockFrom.mockReturnValueOnce(chain1);
      // Remaining queries use default chain

      await expect(adminService.getUserDetail('u-1')).rejects.toEqual(err);
    });
  });

  describe('updateUserLevel', () => {
    it('updates user level', async () => {
      const chain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await adminService.updateUserLevel('u-1', 'oro');

      expect(mockFrom).toHaveBeenCalledWith('users');
      expect(chain.update).toHaveBeenCalledWith({ level: 'oro' });
      expect(chain.eq).toHaveBeenCalledWith('id', 'u-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.updateUserLevel('u-1', 'plata')).rejects.toEqual(err);
    });
  });

  // ==================== Rides ====================
  describe('getRides', () => {
    it('returns rides without filter', async () => {
      const rides = [{ id: 'r-1', status: 'completed' }];
      const chain = createMockQueryChain({ data: rides, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getRides({});

      expect(mockFrom).toHaveBeenCalledWith('rides');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.range).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(rides);
    });

    it('returns rides with status filter', async () => {
      const rides = [{ id: 'r-1', status: 'in_progress' }];
      const chain = createMockQueryChain({ data: rides, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getRides({ status: 'in_progress' });

      expect(chain.eq).toHaveBeenCalledWith('status', 'in_progress');
      expect(result).toEqual(rides);
    });

    it('applies serviceType filter', async () => {
      const rides = [{ id: 'r-1', service_type: 'moto_standard' }];
      const chain = createMockQueryChain({ data: rides, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getRides({ serviceType: 'moto_standard' });

      expect(chain.eq).toHaveBeenCalledWith('service_type', 'moto_standard');
      expect(result).toEqual(rides);
    });

    it('applies paymentMethod filter', async () => {
      const rides = [{ id: 'r-1', payment_method: 'cash' }];
      const chain = createMockQueryChain({ data: rides, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getRides({ paymentMethod: 'cash' });

      expect(chain.eq).toHaveBeenCalledWith('payment_method', 'cash');
      expect(result).toEqual(rides);
    });

    it('applies search filter via or (address)', async () => {
      const rides = [{ id: 'r-1' }];
      const chain = createMockQueryChain({ data: rides, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getRides({ search: 'Vedado' });

      expect(chain.or).toHaveBeenCalledWith('pickup_address.ilike.%Vedado%,dropoff_address.ilike.%Vedado%');
      expect(result).toEqual(rides);
    });

    it('applies date range filters', async () => {
      const rides = [{ id: 'r-1' }];
      const chain = createMockQueryChain({ data: rides, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getRides({ dateFrom: '2026-01-01', dateTo: '2026-01-31' });

      expect(chain.gte).toHaveBeenCalledWith('created_at', '2026-01-01');
      expect(chain.lt).toHaveBeenCalledWith('created_at', '2026-01-31T23:59:59');
      expect(result).toEqual(rides);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getRides()).rejects.toEqual(err);
    });
  });

  describe('getRideDetail', () => {
    it('returns ride detail with driver info when driver_id exists', async () => {
      const ride = { id: 'r-1', driver_id: 'd-1', customer_id: 'u-1' };
      const transitions = [{ id: 'rt-1', status: 'accepted' }];
      const pricing = { id: 'rps-1', base_fare: 3000 };

      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: ride, error: null });

      const chain2 = createMockQueryChain({ data: transitions, error: null });

      const chain3 = createMockQueryChain();
      chain3.maybeSingle.mockResolvedValue({ data: pricing, error: null });

      const chain4 = createMockQueryChain();
      chain4.single.mockResolvedValue({ data: { user_id: 'u-driver' }, error: null });

      const chain5 = createMockQueryChain();
      chain5.single.mockResolvedValue({ data: { full_name: 'Carlos', phone: '555-1' }, error: null });

      const chain6 = createMockQueryChain();
      chain6.single.mockResolvedValue({ data: { full_name: 'Maria', phone: '555-2' }, error: null });

      mockFrom
        .mockReturnValueOnce(chain1)  // rides
        .mockReturnValueOnce(chain2)  // ride_transitions
        .mockReturnValueOnce(chain3)  // ride_pricing_snapshots
        .mockReturnValueOnce(chain4)  // driver_profiles
        .mockReturnValueOnce(chain5)  // users (driver)
        .mockReturnValueOnce(chain6); // users (customer)

      const result = await adminService.getRideDetail('r-1');

      expect(result.ride).toEqual(ride);
      expect(result.transitions).toEqual(transitions);
      expect(result.pricing).toEqual(pricing);
      expect(result.driverInfo).toEqual({ name: 'Carlos', phone: '555-1' });
      expect(result.customerInfo).toEqual({ name: 'Maria', phone: '555-2' });
    });

    it('returns ride detail without driver info when no driver_id', async () => {
      const ride = { id: 'r-2', driver_id: null, customer_id: 'u-2' };

      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: ride, error: null });

      const chain2 = createMockQueryChain({ data: [], error: null });

      const chain3 = createMockQueryChain();
      chain3.maybeSingle.mockResolvedValue({ data: null, error: null });

      const chain4 = createMockQueryChain();
      chain4.single.mockResolvedValue({ data: { full_name: 'Ana', phone: '555-3' }, error: null });

      mockFrom
        .mockReturnValueOnce(chain1)  // rides
        .mockReturnValueOnce(chain2)  // ride_transitions
        .mockReturnValueOnce(chain3)  // ride_pricing_snapshots
        .mockReturnValueOnce(chain4); // users (customer only)

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
      const chain = createMockQueryChain({ data: logs, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getAuditLog(0, 50);

      expect(mockFrom).toHaveBeenCalledWith('audit_log');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(chain.range).toHaveBeenCalledWith(0, 49);
      expect(result).toEqual(logs);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getAuditLog()).rejects.toEqual(err);
    });
  });

  describe('getAdminActions', () => {
    it('returns admin actions without date filters', async () => {
      const actions = [{ id: 'aa-1', action: 'approve_driver' }];
      const chain = createMockQueryChain({ data: actions, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getAdminActions(0, 50, {});

      expect(mockFrom).toHaveBeenCalledWith('admin_actions');
      expect(chain.range).toHaveBeenCalledWith(0, 49);
      expect(result).toEqual(actions);
    });

    it('applies date range filters when provided', async () => {
      const actions = [{ id: 'aa-1', action: 'approve_driver' }];
      const chain = createMockQueryChain({ data: actions, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getAdminActions(0, 50, {
        dateFrom: '2026-03-01',
        dateTo: '2026-03-10',
      });

      expect(chain.gte).toHaveBeenCalledWith('created_at', '2026-03-01');
      expect(chain.lt).toHaveBeenCalledWith('created_at', '2026-03-11');
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

  describe('getAdminTransactions', () => {
    it('returns paginated ledger transactions', async () => {
      const txns = [{ id: 'lt-1', type: 'recharge', amount: 5000 }];
      const chain = createMockQueryChain({ data: txns, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getAdminTransactions(0, 20);

      expect(mockFrom).toHaveBeenCalledWith('ledger_transactions');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.range).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(txns);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getAdminTransactions()).rejects.toEqual(err);
    });
  });

  describe('getPendingRecharges', () => {
    it('returns pending recharges with user names', async () => {
      const rawData = [
        { id: 'rr-1', amount: 10000, status: 'pending', users: { full_name: 'Luis' } },
      ];
      const chain = createMockQueryChain({ data: rawData, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getPendingRecharges();

      expect(mockFrom).toHaveBeenCalledWith('wallet_recharge_requests');
      // Service names the FK explicitly because wallet_recharge_requests
      // has TWO FKs to users (user_id + processed_by). The implicit
      // `users!inner(...)` returns PostgREST 300 ("Multiple Choices").
      expect(chain.select).toHaveBeenCalledWith(
        '*, users!wallet_recharge_requests_user_id_fkey!inner(full_name)',
      );
      expect(chain.eq).toHaveBeenCalledWith('status', 'pending');
      expect(result[0]!.user_name).toBe('Luis');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getPendingRecharges()).rejects.toEqual(err);
    });
  });

  describe('processRecharge', () => {
    it('processes an approved recharge via approve_wallet_recharge RPC', async () => {
      // BUG-116 + BUG-175: single atomic RPC call (idempotent via
      // ledger_transactions.idempotency_key). Replaces the old 5-call
      // client-side flow.
      mockRpc.mockResolvedValueOnce({ data: 'txn-1', error: null });

      // After RPC, service inserts admin_actions row
      const adminActionsChain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(adminActionsChain);

      await adminService.processRecharge('rr-1', 'admin-1', true);

      expect(mockRpc).toHaveBeenCalledWith('approve_wallet_recharge', {
        p_request_id: 'rr-1',
        p_admin_id: 'admin-1',
      });
      expect(adminActionsChain.insert).toHaveBeenCalledWith(expect.objectContaining({
        admin_id: 'admin-1',
        action: 'approve_recharge',
        target_id: 'rr-1',
      }));
    });

    it('processes a rejected recharge', async () => {
      const updateChain = createMockQueryChain({ data: null, error: null });
      const insertChain = createMockQueryChain({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(updateChain)
        .mockReturnValueOnce(insertChain);

      await adminService.processRecharge('rr-1', 'admin-1', false, 'Invalid receipt');

      expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'rejected',
        processed_by: 'admin-1',
        rejection_reason: 'Invalid receipt',
      }));
      expect(updateChain.eq).toHaveBeenCalledWith('id', 'rr-1');
      expect(insertChain.insert).toHaveBeenCalledWith(expect.objectContaining({
        action: 'reject_recharge',
        reason: 'Invalid receipt',
      }));
    });
  });

  // ==================== Service Types ====================
  describe('getServiceTypeConfigs', () => {
    it('returns service type configs ordered by slug', async () => {
      const configs = [{ id: 'stc-1', slug: 'moto', name_es: 'Moto' }];
      const chain = createMockQueryChain({ data: configs, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getServiceTypeConfigs();

      expect(mockFrom).toHaveBeenCalledWith('service_type_configs');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.order).toHaveBeenCalledWith('slug');
      expect(result).toEqual(configs);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getServiceTypeConfigs()).rejects.toEqual(err);
    });
  });

  describe('updateServiceTypeConfig', () => {
    it('updates service type config with updated_at', async () => {
      const chain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await adminService.updateServiceTypeConfig('stc-1', { base_fare_cup: 5000 });

      expect(mockFrom).toHaveBeenCalledWith('service_type_configs');
      expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({
        base_fare_cup: 5000,
        updated_at: expect.any(String),
      }));
      expect(chain.eq).toHaveBeenCalledWith('id', 'stc-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.updateServiceTypeConfig('stc-1', {})).rejects.toEqual(err);
    });
  });

  // ==================== Pricing Rules ====================
  describe('getPricingRules', () => {
    it('returns paginated pricing rules ordered by service_type', async () => {
      const rules = [{ id: 'pr-1', service_type: 'moto', base_fare_cup: 3000 }];
      const chain = createMockQueryChain({ data: rules, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getPricingRules(0, 20);

      expect(mockFrom).toHaveBeenCalledWith('pricing_rules');
      expect(chain.order).toHaveBeenCalledWith('service_type');
      expect(chain.range).toHaveBeenCalledWith(0, 19);
      expect(result).toEqual(rules);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getPricingRules()).rejects.toEqual(err);
    });
  });

  describe('createPricingRule', () => {
    it('inserts a pricing rule', async () => {
      const chain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await adminService.createPricingRule({ service_type: 'moto', base_fare_cup: 3000 } as any);

      expect(mockFrom).toHaveBeenCalledWith('pricing_rules');
      expect(chain.insert).toHaveBeenCalled();
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.createPricingRule({} as any)).rejects.toEqual(err);
    });
  });

  describe('updatePricingRule', () => {
    it('updates a pricing rule', async () => {
      const chain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await adminService.updatePricingRule('pr-1', { base_fare_cup: 5000 });

      expect(mockFrom).toHaveBeenCalledWith('pricing_rules');
      expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ base_fare_cup: 5000 }));
      expect(chain.eq).toHaveBeenCalledWith('id', 'pr-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.updatePricingRule('pr-1', {})).rejects.toEqual(err);
    });
  });

  describe('deletePricingRule', () => {
    it('deletes a pricing rule', async () => {
      const chain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await adminService.deletePricingRule('pr-1');

      expect(mockFrom).toHaveBeenCalledWith('pricing_rules');
      expect(chain.delete).toHaveBeenCalled();
      expect(chain.eq).toHaveBeenCalledWith('id', 'pr-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Delete failed', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.deletePricingRule('pr-1')).rejects.toEqual(err);
    });
  });

  // ==================== Platform Config ====================
  describe('getPlatformConfig', () => {
    it('returns platform config', async () => {
      const configs = [{ key: 'maintenance_mode', value: 'false' }];
      const chain = createMockQueryChain({ data: configs, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getPlatformConfig();

      expect(mockFrom).toHaveBeenCalledWith('platform_config');
      expect(chain.select).toHaveBeenCalledWith('key, value');
      expect(result).toEqual(configs);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getPlatformConfig()).rejects.toEqual(err);
    });
  });

  describe('updatePlatformConfig', () => {
    it('updates platform config', async () => {
      const chain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await adminService.updatePlatformConfig('maintenance_mode', 'true');

      expect(mockFrom).toHaveBeenCalledWith('platform_config');
      expect(chain.upsert).toHaveBeenCalledWith(
        { key: 'maintenance_mode', value: 'true' },
        { onConflict: 'key' },
      );
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.updatePlatformConfig('k', 'v')).rejects.toEqual(err);
    });

    // ADM-002 (security audit 2026-05-23, Admin escalation kill chain):
    // Migration 00292 split pc_admin policy into super_admin write +
    // admin read. A regular admin (non-super) attempting to UPDATE
    // platform_config now gets RLS permission denied (Postgres
    // returns code 42501). The service surfaces the error verbatim
    // so the UI can show "Requires super_admin" via the
    // useIsSuperAdmin gate (apps/admin/src/hooks/useIsSuperAdmin.ts).
    it('throws RLS permission denied when regular admin tries to update commission_rate (ADM-002)', async () => {
      const err = {
        message: 'new row violates row-level security policy for table "platform_config"',
        code: '42501',
      };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(
        adminService.updatePlatformConfig('commission_rate', '0'),
      ).rejects.toEqual(err);
    });
  });

  // ==================== promoteUserRole (ADM-001) ====================
  //
  // ADM-001 (security audit 2026-05-23): direct UPDATE of users.role
  // is now blocked by tg_users_protect_admin_fields (mig 00291) for
  // non-super-admins. The promote_user_role RPC is the only
  // legitimate path; it requires super_admin caller + reason >=10
  // chars + logs to admin_actions.
  describe('promoteUserRole', () => {
    it('promotes a user to super_admin when caller is super_admin (ADM-001c)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          success: true,
          target_user_id: 'u-99',
          old_role: 'admin',
          new_role: 'super_admin',
          reason: 'founder transition Q2 — handover from previous CEO',
        },
        error: null,
      });

      const result = await adminService.promoteUserRole(
        'u-99',
        'super_admin',
        'founder transition Q2 — handover from previous CEO',
      );

      expect(mockRpc).toHaveBeenCalledWith('promote_user_role', {
        p_target_user_id: 'u-99',
        p_new_role: 'super_admin',
        p_reason: 'founder transition Q2 — handover from previous CEO',
      });
      expect(result.success).toBe(true);
      expect(result.old_role).toBe('admin');
      expect(result.new_role).toBe('super_admin');
    });

    it('throws forbidden when caller is not super_admin (ADM-001b)', async () => {
      const err = {
        message: 'forbidden: only super_admin can promote user roles',
        code: 'P0001',
      };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(
        adminService.promoteUserRole('u-99', 'super_admin', 'attempted privilege escalation'),
      ).rejects.toEqual(err);
    });

    it('throws when reason is too short (ADM-001a)', async () => {
      const err = {
        message: 'reason required (min 10 chars): document why this role change is needed',
        code: 'P0001',
      };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(
        adminService.promoteUserRole('u-99', 'admin', 'no'),
      ).rejects.toEqual(err);
    });
  });

  // ==================== Surge Zones ====================
  describe('getSurgeZones', () => {
    it('returns surge zones', async () => {
      const zones = [{ id: 'sz-1', name: 'Downtown', multiplier: 1.5 }];
      const chain = createMockQueryChain({ data: zones, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await adminService.getSurgeZones();

      expect(mockFrom).toHaveBeenCalledWith('surge_zones');
      expect(result).toEqual(zones);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(adminService.getSurgeZones()).rejects.toEqual(err);
    });
  });

});
