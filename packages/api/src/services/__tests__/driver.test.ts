import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockQueryChain } from './helpers/mockSupabase';

// Mock the Supabase client
const mockFrom = vi.fn(() => createMockQueryChain());
const mockRpc = vi.fn();
const mockStorageUpload = vi.fn();
const mockStorageFrom = vi.fn(() => ({ upload: mockStorageUpload }));
const mockStorage = { from: mockStorageFrom };
const mockSupabase = { from: mockFrom, rpc: mockRpc, storage: mockStorage };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Mock notification service
vi.mock('../notification.service', () => ({
  notificationService: {
    notifyUser: vi.fn().mockResolvedValue(undefined),
    sendPush: vi.fn(),
  },
}));

// Mock global fetch for uploadDocument
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mock is set up
import { driverService } from '../driver.service';

describe('driverService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => createMockQueryChain());
  });

  // ==================== getProfile ====================
  describe('getProfile', () => {
    it('returns driver profile for user', async () => {
      const mockProfile = { id: 'd-1', user_id: 'u-1', status: 'active' };
      const chain = createMockQueryChain();
      chain.maybeSingle.mockResolvedValue({ data: mockProfile, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.getProfile('u-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.eq).toHaveBeenCalledWith('user_id', 'u-1');
      expect(result).toEqual(mockProfile);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain();
      chain.maybeSingle.mockResolvedValue({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.getProfile('u-1')).rejects.toEqual(err);
    });
  });

  // ==================== createProfile ====================
  describe('createProfile', () => {
    it('inserts driver profile and returns it', async () => {
      const mockProfile = {
        id: 'd-1',
        user_id: 'u-1',
        status: 'pending_verification',
        is_online: false,
        rating_avg: 5.0,
        total_rides: 0,
        total_rides_completed: 0,
      };
      const chain = createMockQueryChain();
      chain.single.mockResolvedValue({ data: mockProfile, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.createProfile('u-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(chain.insert).toHaveBeenCalledWith({
        user_id: 'u-1',
        status: 'pending_verification',
        is_online: false,
        rating_avg: 5.0,
        total_rides: 0,
        total_rides_completed: 0,
      });
      expect(result).toEqual(mockProfile);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Duplicate', code: '23505' };
      const chain = createMockQueryChain();
      chain.single.mockResolvedValue({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.createProfile('u-1')).rejects.toEqual(err);
    });
  });

  // ==================== uploadDocument ====================
  describe('uploadDocument', () => {
    it('uploads file to storage and creates document record', async () => {
      const mockBlob = new Blob(['file-content']);
      mockFetch.mockResolvedValueOnce({ blob: () => Promise.resolve(mockBlob) });

      mockStorageUpload.mockResolvedValueOnce({ error: null });

      const mockDoc = {
        id: 'doc-1',
        driver_id: 'd-1',
        document_type: 'license',
        storage_path: 'driver-docs/d-1/license/license.jpg',
        file_name: 'license.jpg',
      };
      const chain = createMockQueryChain();
      chain.single.mockResolvedValue({ data: mockDoc, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.uploadDocument(
        'd-1',
        'license',
        'file:///path/to/license.jpg',
        'license.jpg',
      );

      expect(mockStorageFrom).toHaveBeenCalledWith('driver-documents');
      expect(mockStorageUpload).toHaveBeenCalledWith(
        'driver-docs/d-1/license/license.jpg',
        mockBlob,
      );
      expect(mockFrom).toHaveBeenCalledWith('driver_documents');
      expect(chain.insert).toHaveBeenCalledWith({
        driver_id: 'd-1',
        document_type: 'license',
        storage_path: 'driver-docs/d-1/license/license.jpg',
        file_name: 'license.jpg',
      });
      expect(result).toEqual(mockDoc);
    });

    it('throws on storage upload error', async () => {
      const mockBlob = new Blob(['file-content']);
      mockFetch.mockResolvedValueOnce({ blob: () => Promise.resolve(mockBlob) });

      const uploadErr = { message: 'Storage full', code: '507' };
      mockStorageUpload.mockResolvedValueOnce({ error: uploadErr });

      await expect(
        driverService.uploadDocument('d-1', 'license', 'file:///path/to/license.jpg', 'license.jpg'),
      ).rejects.toEqual(uploadErr);
    });
  });

  // ==================== getDocuments ====================
  describe('getDocuments', () => {
    it('returns documents for a driver', async () => {
      const mockDocs = [
        { id: 'doc-1', driver_id: 'd-1', document_type: 'license' },
        { id: 'doc-2', driver_id: 'd-1', document_type: 'insurance' },
      ];
      const chain = createMockQueryChain({ data: mockDocs, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.getDocuments('d-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_documents');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.eq).toHaveBeenCalledWith('driver_id', 'd-1');
      expect(chain.order).toHaveBeenCalledWith('uploaded_at', { ascending: false });
      expect(result).toEqual(mockDocs);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.getDocuments('d-1')).rejects.toEqual(err);
    });
  });

  // ==================== getVehicle ====================
  describe('getVehicle', () => {
    it('returns active vehicle for a driver', async () => {
      const mockVehicle = { id: 'v-1', driver_id: 'd-1', is_active: true };
      const chain = createMockQueryChain();
      chain.maybeSingle.mockResolvedValue({ data: mockVehicle, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.getVehicle('d-1');

      expect(mockFrom).toHaveBeenCalledWith('vehicles');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.eq).toHaveBeenCalledWith('driver_id', 'd-1');
      expect(chain.eq).toHaveBeenCalledWith('is_active', true);
      expect(chain.limit).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockVehicle);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain();
      chain.maybeSingle.mockResolvedValue({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.getVehicle('d-1')).rejects.toEqual(err);
    });
  });

  // ==================== registerVehicle ====================
  describe('registerVehicle', () => {
    it('inserts vehicle and returns it', async () => {
      const vehicleInput = {
        driver_id: 'd-1',
        plate_number: 'ABC-123',
        model: 'Bajaj RE',
        year: 2023,
        is_active: true,
      };
      const mockVehicle = { id: 'v-1', ...vehicleInput };
      const chain = createMockQueryChain();
      chain.single.mockResolvedValue({ data: mockVehicle, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.registerVehicle(vehicleInput as any);

      expect(mockFrom).toHaveBeenCalledWith('vehicles');
      expect(chain.insert).toHaveBeenCalledWith(vehicleInput);
      expect(result).toEqual(mockVehicle);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const chain = createMockQueryChain();
      chain.single.mockResolvedValue({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.registerVehicle({} as any)).rejects.toEqual(err);
    });
  });

  // ==================== submitForVerification ====================
  describe('submitForVerification', () => {
    it('updates driver profile status to under_review', async () => {
      const chain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await driverService.submitForVerification('d-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(chain.update).toHaveBeenCalledWith({ status: 'under_review' });
      expect(chain.eq).toHaveBeenCalledWith('id', 'd-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.submitForVerification('d-1')).rejects.toEqual(err);
    });
  });

  // ==================== setOnlineStatus ====================
  describe('setOnlineStatus', () => {
    it('updates online status with location', async () => {
      const chain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await driverService.setOnlineStatus('d-1', true, { latitude: 4.6, longitude: -74.08 });

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(chain.update).toHaveBeenCalledWith({
        is_online: true,
        current_location: 'POINT(-74.08 4.6)',
      });
      expect(chain.eq).toHaveBeenCalledWith('id', 'd-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(
        driverService.setOnlineStatus('d-1', false),
      ).rejects.toThrow();
    });
  });

  // ==================== updateLocation ====================
  describe('updateLocation', () => {
    it('updates driver location with heading', async () => {
      const chain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await driverService.updateLocation('d-1', 4.6, -74.08, 180);

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(chain.update).toHaveBeenCalledWith({
        current_location: 'POINT(-74.08 4.6)',
        current_heading: 180,
      });
      expect(chain.eq).toHaveBeenCalledWith('id', 'd-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.updateLocation('d-1', 4.6, -74.08)).rejects.toThrow();
    });
  });

  // ==================== acceptRide ====================
  describe('acceptRide', () => {
    function mockAcceptRideFromCalls() {
      // 1. driver_profiles select (custom rate)
      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: { custom_per_km_rate_cup: null }, error: null });

      // 2. rides select (ride data)
      const chain2 = createMockQueryChain();
      chain2.single.mockResolvedValue({
        data: {
          id: 'r-1', service_type: 'triciclo', estimated_distance_m: 5000,
          estimated_duration_s: 600, surge_multiplier: 1, discount_amount_cup: 0,
          exchange_rate_usd_cup: 300,
        },
        error: null,
      });

      // 3. service_type_configs select
      const chain3 = createMockQueryChain();
      chain3.single.mockResolvedValue({
        data: { base_fare_cup: 2000, per_km_rate_cup: 1000, per_minute_rate_cup: 200, min_fare_cup: 5000 },
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(chain1)
        .mockReturnValueOnce(chain2)
        .mockReturnValueOnce(chain3);
    }

    it('updates ride with driver_id and accepted status', async () => {
      mockAcceptRideFromCalls();

      // 4. RPC accept_ride
      mockRpc.mockResolvedValueOnce({
        data: { success: true, ride_id: 'r-1' },
        error: null,
      });

      // 5. from('rides').update (fare data) — uses default chain
      // 6. from('rides').select('*') — fetch updated ride
      const rideChain = createMockQueryChain();
      rideChain.single.mockResolvedValue({
        data: { id: 'r-1', driver_id: 'd-1', status: 'accepted', ride_mode: 'passenger' },
        error: null,
      });
      // The 4th from() returns default (for fare update), 5th returns rideChain
      mockFrom
        .mockReturnValueOnce(createMockQueryChain()) // rides.update (fare)
        .mockReturnValueOnce(rideChain);             // rides.select (fetch)

      const result = await driverService.acceptRide('r-1', 'd-1');

      expect(mockRpc).toHaveBeenCalledWith('accept_ride', {
        p_ride_id: 'r-1',
        p_driver_id: 'd-1',
      });
      expect(result).toBeDefined();
      expect(result.status).toBe('accepted');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Ride not found', code: 'PGRST116' };
      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain1);

      await expect(driverService.acceptRide('r-1', 'd-1')).rejects.toEqual(err);
    });
  });

  // ==================== updateRideStatus ====================
  describe('updateRideStatus', () => {
    it('updates ride status with arrived_at_pickup timestamp', async () => {
      const chain = createMockQueryChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await driverService.updateRideStatus('r-1', 'arrived_at_pickup' as any);

      expect(mockFrom).toHaveBeenCalledWith('rides');
      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'arrived_at_pickup',
          driver_arrived_at: expect.any(String),
        }),
      );
      expect(chain.eq).toHaveBeenCalledWith('id', 'r-1');
    });

    it('throws when status is completed', async () => {
      await expect(
        driverService.updateRideStatus('r-1', 'completed' as any),
      ).rejects.toThrow('Use completeRide() for ride completion');
    });
  });

  // ==================== completeRide ====================
  describe('completeRide', () => {
    it('calls rpc with correct parameters', async () => {
      const mockResult = { fare: 8500, status: 'completed' };
      mockRpc.mockResolvedValueOnce({ data: mockResult, error: null });

      const params = {
        rideId: 'r-1',
        driverId: 'd-1',
        actualDistanceM: 2500,
        actualDurationS: 600,
      };
      const result = await driverService.completeRide(params);

      expect(mockRpc).toHaveBeenCalledWith('complete_ride_and_pay', {
        p_ride_id: 'r-1',
        p_driver_id: 'd-1',
        p_actual_distance_m: 2500,
        p_actual_duration_s: 600,
      });
      expect(result).toEqual(mockResult);
    });

    it('throws on rpc error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC failed', code: '500' } });

      await expect(
        driverService.completeRide({
          rideId: 'r-1',
          driverId: 'd-1',
          actualDistanceM: 2500,
          actualDurationS: 600,
        }),
      ).rejects.toThrow('RPC failed');
    });
  });

  // ==================== getActiveTrip ====================
  describe('getActiveTrip', () => {
    it('returns active trip for driver', async () => {
      const mockRide = { id: 'r-1', driver_id: 'd-1', status: 'in_progress' };
      const chain = createMockQueryChain();
      chain.maybeSingle.mockResolvedValue({ data: mockRide, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.getActiveTrip('d-1');

      expect(mockFrom).toHaveBeenCalledWith('rides');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.eq).toHaveBeenCalledWith('driver_id', 'd-1');
      expect(chain.in).toHaveBeenCalledWith('status', [
        'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination',
      ]);
      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(chain.limit).toHaveBeenCalledWith(1);
      expect(result).toBeDefined();
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain();
      chain.maybeSingle.mockResolvedValue({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.getActiveTrip('d-1')).rejects.toEqual(err);
    });
  });

  // ==================== getTripHistory ====================
  describe('getTripHistory', () => {
    it('returns paginated trip history', async () => {
      const mockRides = [
        { id: 'r-1', status: 'completed' },
        { id: 'r-2', status: 'canceled' },
      ];
      const chain = createMockQueryChain({ data: mockRides, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.getTripHistory('d-1', 2, 10);

      expect(mockFrom).toHaveBeenCalledWith('rides');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.eq).toHaveBeenCalledWith('driver_id', 'd-1');
      expect(chain.in).toHaveBeenCalledWith('status', ['completed', 'canceled']);
      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(chain.range).toHaveBeenCalledWith(20, 29);
      expect(result).toBeDefined();
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.getTripHistory('d-1')).rejects.toEqual(err);
    });
  });

  // ==================== checkEligibility ====================
  describe('checkEligibility', () => {
    it('calls rpc and returns boolean', async () => {
      mockRpc.mockResolvedValueOnce({ data: true, error: null });

      const result = await driverService.checkEligibility('d-1');

      expect(mockRpc).toHaveBeenCalledWith('check_driver_eligibility', {
        p_driver_id: 'd-1',
      });
      expect(result).toBe(true);
    });

    it('throws on rpc error', async () => {
      const err = { message: 'RPC failed', code: '500' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(driverService.checkEligibility('d-1')).rejects.toEqual(err);
    });
  });

  // ==================== getEligibilityStatus ====================
  describe('getEligibilityStatus', () => {
    it('returns eligibility status for driver', async () => {
      const mockData = {
        is_financially_eligible: false,
        negative_balance_since: '2026-01-15T00:00:00Z',
      };
      const chain = createMockQueryChain();
      chain.single.mockResolvedValue({ data: mockData, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.getEligibilityStatus('d-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(chain.select).toHaveBeenCalledWith('is_financially_eligible, negative_balance_since');
      expect(chain.eq).toHaveBeenCalledWith('id', 'd-1');
      expect(result).toEqual({
        is_eligible: false,
        negative_since: '2026-01-15T00:00:00Z',
      });
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain();
      chain.single.mockResolvedValue({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.getEligibilityStatus('d-1')).rejects.toEqual(err);
    });
  });

  // ==================== acceptRideWithEligibility ====================
  describe('acceptRideWithEligibility', () => {
    it('checks eligibility and accepts ride when eligible', async () => {
      // Mock rpc: eligibility check, then accept_ride
      mockRpc
        .mockResolvedValueOnce({ data: true, error: null })                      // check_accept_ride_eligibility
        .mockResolvedValueOnce({ data: { success: true, ride_id: 'r-1' }, error: null }); // accept_ride

      // acceptRide makes 3 from() calls for config data
      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: { custom_per_km_rate_cup: null }, error: null });

      const chain2 = createMockQueryChain();
      chain2.single.mockResolvedValue({
        data: {
          id: 'r-1', service_type: 'triciclo', estimated_distance_m: 5000,
          estimated_duration_s: 600, surge_multiplier: 1, discount_amount_cup: 0,
          exchange_rate_usd_cup: 300,
        },
        error: null,
      });

      const chain3 = createMockQueryChain();
      chain3.single.mockResolvedValue({
        data: { base_fare_cup: 2000, per_km_rate_cup: 1000, per_minute_rate_cup: 200, min_fare_cup: 5000 },
        error: null,
      });

      // After config calls: fare update chain, then fetch ride chain
      const rideChain = createMockQueryChain();
      rideChain.single.mockResolvedValue({
        data: { id: 'r-1', driver_id: 'd-1', status: 'accepted', ride_mode: 'passenger' },
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(chain1)
        .mockReturnValueOnce(chain2)
        .mockReturnValueOnce(chain3)
        .mockReturnValueOnce(createMockQueryChain()) // rides.update (fare)
        .mockReturnValueOnce(rideChain);             // rides.select (fetch)

      const result = await driverService.acceptRideWithEligibility('r-1', 'd-1');

      expect(mockRpc).toHaveBeenCalledWith('check_accept_ride_eligibility', {
        p_driver_id: 'd-1',
      });
      expect(result).toBeDefined();
    });

    it('throws when driver is not eligible', async () => {
      mockRpc.mockResolvedValueOnce({ data: false, error: null });

      await expect(
        driverService.acceptRideWithEligibility('r-1', 'd-1'),
      ).rejects.toThrow('No puedes aceptar viajes: tu cuenta tiene un saldo negativo pendiente.');
    });
  });

  // ==================== getCancellationPenalties ====================
  describe('getCancellationPenalties', () => {
    it('returns cancellation penalties for user', async () => {
      const mockPenalties = [
        { id: 'p-1', user_id: 'u-1', amount: 2000 },
        { id: 'p-2', user_id: 'u-1', amount: 3000 },
      ];
      const chain = createMockQueryChain({ data: mockPenalties, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.getCancellationPenalties('u-1', 5);

      expect(mockFrom).toHaveBeenCalledWith('cancellation_penalties');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.eq).toHaveBeenCalledWith('user_id', 'u-1');
      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(chain.limit).toHaveBeenCalledWith(5);
      expect(result).toEqual(mockPenalties);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(driverService.getCancellationPenalties('u-1')).rejects.toEqual(err);
    });
  });
});
