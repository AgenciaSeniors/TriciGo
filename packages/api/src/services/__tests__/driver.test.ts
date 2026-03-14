import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockStorageUpload = vi.fn();
const mockStorageFrom = vi.fn(() => ({ upload: mockStorageUpload }));
const mockStorage = { from: mockStorageFrom };
const mockSupabase = { from: mockFrom, rpc: mockRpc, storage: mockStorage };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Mock global fetch for uploadDocument
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mock is set up
import { driverService } from '../driver.service';

describe('driverService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== getProfile ====================
  describe('getProfile', () => {
    it('returns driver profile for user', async () => {
      const mockProfile = { id: 'd-1', user_id: 'u-1', status: 'active' };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: mockProfile, error: null });
      const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await driverService.getProfile('u-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('user_id', 'u-1');
      expect(result).toEqual(mockProfile);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

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
      const mockSingle = vi.fn().mockResolvedValue({ data: mockProfile, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await driverService.createProfile('u-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(mockInsert).toHaveBeenCalledWith({
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
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

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
      const mockSingle = vi.fn().mockResolvedValue({ data: mockDoc, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

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
      expect(mockInsert).toHaveBeenCalledWith({
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
      const mockOrder = vi.fn().mockResolvedValue({ data: mockDocs, error: null });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await driverService.getDocuments('d-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_documents');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('driver_id', 'd-1');
      expect(mockOrder).toHaveBeenCalledWith('uploaded_at', { ascending: false });
      expect(result).toEqual(mockDocs);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockOrder = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(driverService.getDocuments('d-1')).rejects.toEqual(err);
    });
  });

  // ==================== getVehicle ====================
  describe('getVehicle', () => {
    it('returns active vehicle for a driver', async () => {
      const mockVehicle = { id: 'v-1', driver_id: 'd-1', is_active: true };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: mockVehicle, error: null });
      const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockEqActive = vi.fn(() => ({ limit: mockLimit }));
      const mockEqDriver = vi.fn(() => ({ eq: mockEqActive }));
      const mockSelect = vi.fn(() => ({ eq: mockEqDriver }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await driverService.getVehicle('d-1');

      expect(mockFrom).toHaveBeenCalledWith('vehicles');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEqDriver).toHaveBeenCalledWith('driver_id', 'd-1');
      expect(mockEqActive).toHaveBeenCalledWith('is_active', true);
      expect(mockLimit).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockVehicle);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockEqActive = vi.fn(() => ({ limit: mockLimit }));
      const mockEqDriver = vi.fn(() => ({ eq: mockEqActive }));
      const mockSelect = vi.fn(() => ({ eq: mockEqDriver }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

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
      const mockSingle = vi.fn().mockResolvedValue({ data: mockVehicle, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await driverService.registerVehicle(vehicleInput as any);

      expect(mockFrom).toHaveBeenCalledWith('vehicles');
      expect(mockInsert).toHaveBeenCalledWith(vehicleInput);
      expect(result).toEqual(mockVehicle);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(driverService.registerVehicle({} as any)).rejects.toEqual(err);
    });
  });

  // ==================== submitForVerification ====================
  describe('submitForVerification', () => {
    it('updates driver profile status to under_review', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await driverService.submitForVerification('d-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(mockUpdate).toHaveBeenCalledWith({ status: 'under_review' });
      expect(mockEq).toHaveBeenCalledWith('id', 'd-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(driverService.submitForVerification('d-1')).rejects.toEqual(err);
    });
  });

  // ==================== setOnlineStatus ====================
  describe('setOnlineStatus', () => {
    it('updates online status with location', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await driverService.setOnlineStatus('d-1', true, { latitude: 4.6, longitude: -74.08 });

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(mockUpdate).toHaveBeenCalledWith({
        is_online: true,
        current_location: 'POINT(-74.08 4.6)',
      });
      expect(mockEq).toHaveBeenCalledWith('id', 'd-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(
        driverService.setOnlineStatus('d-1', false),
      ).rejects.toEqual(err);
    });
  });

  // ==================== updateLocation ====================
  describe('updateLocation', () => {
    it('updates driver location with heading', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await driverService.updateLocation('d-1', 4.6, -74.08, 180);

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(mockUpdate).toHaveBeenCalledWith({
        current_location: 'POINT(-74.08 4.6)',
        current_heading: 180,
      });
      expect(mockEq).toHaveBeenCalledWith('id', 'd-1');
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '42P01' };
      const mockEq = vi.fn().mockResolvedValue({ error: err });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(driverService.updateLocation('d-1', 4.6, -74.08)).rejects.toEqual(err);
    });
  });

  // ==================== acceptRide ====================
  describe('acceptRide', () => {
    /** Helper: mock the 4 from() calls that acceptRide makes */
    function mockAcceptRideFromCalls(overrides?: { updateError?: object }) {
      // 1. from('driver_profiles').select(...)
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: { custom_per_km_rate_cup: null },
              error: null,
            }),
          })),
        })),
      });
      // 2. from('rides').select(*) — get ride data
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 'r-1',
                  service_type: 'triciclo',
                  estimated_distance_m: 5000,
                  estimated_duration_s: 600,
                  surge_multiplier: 1,
                  discount_amount_cup: 0,
                  exchange_rate_usd_cup: 300,
                },
                error: null,
              }),
            })),
          })),
        })),
      });
      // 3. from('service_type_configs').select(...)
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  base_fare_cup: 2000,
                  per_km_rate_cup: 1000,
                  per_minute_rate_cup: 200,
                  min_fare_cup: 5000,
                },
                error: null,
              }),
            })),
          })),
        })),
      });
    }

    it('updates ride with driver_id and accepted status', async () => {
      mockAcceptRideFromCalls();

      // 4. from('rides').update(...)
      const mockRide = { id: 'r-1', driver_id: 'd-1', status: 'accepted' };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockRide, error: null });
      const mockSelectFn = vi.fn(() => ({ single: mockSingle }));
      const mockEqStatus = vi.fn(() => ({ select: mockSelectFn }));
      const mockEqId = vi.fn(() => ({ eq: mockEqStatus }));
      const mockUpdate = vi.fn(() => ({ eq: mockEqId }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      const result = await driverService.acceptRide('r-1', 'd-1');

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          driver_id: 'd-1',
          status: 'accepted',
        }),
      );
      expect(result).toEqual(mockRide);
    });

    it('throws on supabase error', async () => {
      // Mock first from() call to fail (driver_profiles query)
      const err = { message: 'Ride not found', code: 'PGRST116' };
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: null, error: err }),
          })),
        })),
      });

      await expect(driverService.acceptRide('r-1', 'd-1')).rejects.toEqual(err);
    });
  });

  // ==================== updateRideStatus ====================
  describe('updateRideStatus', () => {
    it('updates ride status with arrived_at_pickup timestamp', async () => {
      const mockEq = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await driverService.updateRideStatus('r-1', 'arrived_at_pickup' as any);

      expect(mockFrom).toHaveBeenCalledWith('rides');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'arrived_at_pickup',
          driver_arrived_at: expect.any(String),
        }),
      );
      expect(mockEq).toHaveBeenCalledWith('id', 'r-1');
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
      const err = { message: 'RPC failed', code: '500' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(
        driverService.completeRide({
          rideId: 'r-1',
          driverId: 'd-1',
          actualDistanceM: 2500,
          actualDurationS: 600,
        }),
      ).rejects.toEqual(err);
    });
  });

  // ==================== getActiveTrip ====================
  describe('getActiveTrip', () => {
    it('returns active trip for driver', async () => {
      const mockRide = { id: 'r-1', driver_id: 'd-1', status: 'in_progress' };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: mockRide, error: null });
      const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockIn = vi.fn(() => ({ order: mockOrder }));
      const mockEq = vi.fn(() => ({ in: mockIn }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await driverService.getActiveTrip('d-1');

      expect(mockFrom).toHaveBeenCalledWith('rides');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('driver_id', 'd-1');
      expect(mockIn).toHaveBeenCalledWith('status', [
        'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress',
      ]);
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockLimit).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockRide);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockOrder = vi.fn(() => ({ limit: mockLimit }));
      const mockIn = vi.fn(() => ({ order: mockOrder }));
      const mockEq = vi.fn(() => ({ in: mockIn }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

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
      const mockRange = vi.fn().mockResolvedValue({ data: mockRides, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockIn = vi.fn(() => ({ order: mockOrder }));
      const mockEq = vi.fn(() => ({ in: mockIn }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await driverService.getTripHistory('d-1', 2, 10);

      expect(mockFrom).toHaveBeenCalledWith('rides');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('driver_id', 'd-1');
      expect(mockIn).toHaveBeenCalledWith('status', ['completed', 'canceled']);
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      // page=2, pageSize=10 => from=20, to=29
      expect(mockRange).toHaveBeenCalledWith(20, 29);
      expect(result).toEqual(mockRides);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockIn = vi.fn(() => ({ order: mockOrder }));
      const mockEq = vi.fn(() => ({ in: mockIn }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

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
      const mockSingle = vi.fn().mockResolvedValue({ data: mockData, error: null });
      const mockEq = vi.fn(() => ({ single: mockSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await driverService.getEligibilityStatus('d-1');

      expect(mockFrom).toHaveBeenCalledWith('driver_profiles');
      expect(mockSelect).toHaveBeenCalledWith('is_financially_eligible, negative_balance_since');
      expect(mockEq).toHaveBeenCalledWith('id', 'd-1');
      expect(result).toEqual({
        is_eligible: false,
        negative_since: '2026-01-15T00:00:00Z',
      });
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq = vi.fn(() => ({ single: mockSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(driverService.getEligibilityStatus('d-1')).rejects.toEqual(err);
    });
  });

  // ==================== acceptRideWithEligibility ====================
  describe('acceptRideWithEligibility', () => {
    it('checks eligibility and accepts ride when eligible', async () => {
      // Mock rpc for eligibility check
      mockRpc.mockResolvedValueOnce({ data: true, error: null });

      // acceptRide makes 4 from() calls:
      // 1. from('driver_profiles').select(...) — get driver's custom rate
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: { custom_per_km_rate_cup: null },
              error: null,
            }),
          })),
        })),
      });

      // 2. from('rides').select(*) — get ride data
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 'r-1',
                  service_type: 'triciclo',
                  estimated_distance_m: 5000,
                  estimated_duration_s: 600,
                  surge_multiplier: 1,
                  discount_amount_cup: 0,
                  exchange_rate_usd_cup: 300,
                },
                error: null,
              }),
            })),
          })),
        })),
      });

      // 3. from('service_type_configs').select(...) — get service config
      mockFrom.mockReturnValueOnce({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  base_fare_cup: 2000,
                  per_km_rate_cup: 1000,
                  per_minute_rate_cup: 200,
                  min_fare_cup: 5000,
                },
                error: null,
              }),
            })),
          })),
        })),
      });

      // 4. from('rides').update(...) — update ride with driver assignment
      const mockAcceptedRide = { id: 'r-1', driver_id: 'd-1', status: 'accepted' };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockAcceptedRide, error: null });
      const mockSelectFn = vi.fn(() => ({ single: mockSingle }));
      const mockEqStatus = vi.fn(() => ({ select: mockSelectFn }));
      const mockEqId = vi.fn(() => ({ eq: mockEqStatus }));
      const mockUpdate = vi.fn(() => ({ eq: mockEqId }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      const result = await driverService.acceptRideWithEligibility('r-1', 'd-1');

      expect(mockRpc).toHaveBeenCalledWith('check_accept_ride_eligibility', {
        p_driver_id: 'd-1',
      });
      expect(result).toEqual(mockAcceptedRide);
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
      const mockLimitFn = vi.fn().mockResolvedValue({ data: mockPenalties, error: null });
      const mockOrder = vi.fn(() => ({ limit: mockLimitFn }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await driverService.getCancellationPenalties('u-1', 5);

      expect(mockFrom).toHaveBeenCalledWith('cancellation_penalties');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('user_id', 'u-1');
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockLimitFn).toHaveBeenCalledWith(5);
      expect(result).toEqual(mockPenalties);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockLimitFn = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ limit: mockLimitFn }));
      const mockEq = vi.fn(() => ({ order: mockOrder }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(driverService.getCancellationPenalties('u-1')).rejects.toEqual(err);
    });
  });
});
