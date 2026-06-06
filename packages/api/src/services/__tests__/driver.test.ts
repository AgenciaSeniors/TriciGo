import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockQueryChain } from './helpers/mockSupabase';

// Mock the Supabase client
const mockFrom = vi.fn(() => createMockQueryChain());
const mockRpc = vi.fn();
const mockStorageUpload = vi.fn();
const mockStorageFrom = vi.fn(() => ({ upload: mockStorageUpload }));
const mockStorage = { from: mockStorageFrom };
// Stub realtime broadcast chain used by updateLocation's best-effort broadcast.
const mockChannelSend = vi.fn(() => Promise.resolve({ error: null }));
const mockChannelBuilder = vi.fn(() => ({ send: mockChannelSend }));
// Stub functions.invoke used by uploadSelfieCheck's fire-and-forget verify-selfie call.
const mockFunctionsInvoke = vi.fn(() => Promise.resolve({ data: null, error: null }));
const mockSupabase = {
  from: mockFrom,
  rpc: mockRpc,
  storage: mockStorage,
  channel: mockChannelBuilder,
  functions: { invoke: mockFunctionsInvoke },
};

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
  //
  // Upload now routes through the `storage-upload` Edge Function (service-role)
  // instead of a direct `supabase.storage.from().upload()`: since the
  // publishable-key migration the Storage service rejects the user JWT, so the
  // `uploadFileFromUri` helper posts a FormData body to the EF via
  // `functions.invoke('storage-upload')`. (See _storage-upload.ts / PR #430/#432.)
  describe('uploadDocument', () => {
    it('uploads file to the storage-upload EF and creates document record', async () => {
      mockFunctionsInvoke.mockResolvedValueOnce({
        data: { path: 'driver-docs/d-1/license/license.jpg' },
        error: null,
      });

      const mockDoc = {
        id: 'doc-1',
        driver_id: 'd-1',
        document_type: 'license',
        storage_path: 'driver-docs/d-1/license/license.jpg',
        file_name: 'license.jpg',
        mime_type: 'image/jpeg',
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

      expect(mockFunctionsInvoke).toHaveBeenCalledWith('storage-upload', {
        body: expect.any(FormData),
      });
      expect(mockFrom).toHaveBeenCalledWith('driver_documents');
      expect(chain.insert).toHaveBeenCalledWith({
        driver_id: 'd-1',
        document_type: 'license',
        storage_path: 'driver-docs/d-1/license/license.jpg',
        file_name: 'license.jpg',
        mime_type: 'image/jpeg',
      });
      expect(result).toEqual(mockDoc);
    });

    it('throws when the storage-upload EF returns an error', async () => {
      const uploadErr = { message: 'Storage full', code: '507' };
      mockFunctionsInvoke.mockResolvedValueOnce({ data: null, error: uploadErr });

      await expect(
        driverService.uploadDocument('d-1', 'license', 'file:///path/to/license.jpg', 'license.jpg'),
      ).rejects.toEqual(uploadErr);
    });
  });

  // ==================== uploadSelfieCheck ====================
  //
  // Same EF-routed upload as uploadDocument (functions.invoke('storage-upload')
  // via uploadFileFromUri), then a fire-and-forget verify-selfie invocation.
  describe('uploadSelfieCheck', () => {
    it('uploads selfie via the storage-upload EF and marks the check processing', async () => {
      // storage-upload then verify-selfie both resolve via the default
      // mockFunctionsInvoke ({ data: null, error: null }).
      const mockCheck = { id: 'chk-1', driver_id: 'd-1', status: 'processing' };
      const chain = createMockQueryChain();
      chain.single.mockResolvedValue({ data: mockCheck, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await driverService.uploadSelfieCheck(
        'chk-1',
        'd-1',
        'file:///tmp/selfie.jpg',
        'selfie.jpg',
      );

      expect(mockFunctionsInvoke).toHaveBeenCalledWith('storage-upload', {
        body: expect.any(FormData),
      });
      expect(mockFrom).toHaveBeenCalledWith('selfie_checks');
      expect(result).toEqual(mockCheck);
    });

    it('throws when the storage-upload EF returns an error', async () => {
      const uploadErr = { message: 'Network request failed', code: '500' };
      mockFunctionsInvoke.mockResolvedValueOnce({ data: null, error: uploadErr });

      await expect(
        driverService.uploadSelfieCheck('chk-1', 'd-1', 'file:///tmp/selfie.jpg', 'selfie.jpg'),
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

    // DRV-002 (security audit 2026-05-23, Driver fraud kill chain):
    // Migration 00288 extends tg_driver_profiles_protect_admin_fields
    // with two new lockdowns:
    //   * is_online toggle to true requires status='approved' — the
    //     trigger RAISEs 'driver_not_approved_for_online' for unapproved
    //     drivers. This blocks the dispatch-loop entry path that DRV-001
    //     (00287) closes on the accept side.
    //   * custom_per_km_rate_cup is now admin-only; non-admin updates
    //     silently revert (NEW := OLD pattern) rather than raise, so
    //     this branch is harder to assert at the service layer — it's
    //     covered by manual verification in the PR (see PR-01 body).
    it('throws driver_not_approved_for_online when trigger blocks is_online toggle on unapproved driver (DRV-002)', async () => {
      const err = {
        message:
          "driver_not_approved_for_online: status=pending_verification — cannot go online until approved by admin",
        code: 'P0001',
      };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(
        driverService.setOnlineStatus('d-1', true, { latitude: 4.6, longitude: -74.08 }),
      ).rejects.toThrow(/driver_not_approved_for_online/);
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
  //
  // Migration 00142 collapsed the old multi-SELECT + `accept_ride` flow into
  // a single atomic RPC call to `accept_ride_v2`. Migration 00153 (wallet
  // floor gate) added the 'insufficient_balance' error branch. The tests
  // below cover the three real paths: RPC success, RPC business error, and
  // Supabase-level error.
  describe('acceptRide', () => {
    it('calls accept_ride_v2 RPC and returns the refreshed ride', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { success: true, ride_id: 'r-1' },
        error: null,
      });

      // Post-RPC fetch: from('rides').select('*').eq('id', ...).single()
      const rideChain = createMockQueryChain();
      rideChain.single.mockResolvedValue({
        data: {
          id: 'r-1', driver_id: 'd-1', status: 'accepted', ride_mode: 'passenger',
          pickup_lat: 4.6, pickup_lng: -74.08, dropoff_lat: 4.7, dropoff_lng: -74.09,
        },
        error: null,
      });
      mockFrom.mockReturnValueOnce(rideChain);

      const result = await driverService.acceptRide('r-1', 'd-1');

      expect(mockRpc).toHaveBeenCalledWith('accept_ride_v2', {
        p_ride_id: 'r-1',
        p_driver_id: 'd-1',
      });
      expect(result).toBeDefined();
      expect(result.status).toBe('accepted');
    });

    it('throws an Error with rpcError/rpcPayload when RPC returns a business error', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          error: 'insufficient_balance',
          balance_trc: -500,
          required_trc: 62,
          commission_rate: 0.15,
        },
        error: null,
      });

      try {
        await driverService.acceptRide('r-1', 'd-1');
        throw new Error('expected rejection');
      } catch (err) {
        expect((err as Error).message).toBe('insufficient_balance');
        const enriched = err as Error & { rpcError?: string; rpcPayload?: Record<string, unknown> };
        expect(enriched.rpcError).toBe('insufficient_balance');
        expect(enriched.rpcPayload).toMatchObject({ required_trc: 62, balance_trc: -500 });
      }
    });

    it('throws on supabase transport error', async () => {
      const err = { message: 'Network', code: 'PGRST000' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(driverService.acceptRide('r-1', 'd-1')).rejects.toEqual(err);
    });

    // DRV-001 (security audit 2026-05-23, kill chain Driver fraud):
    // Migration 00287 adds an `IF v_driver.status <> 'approved'` gate
    // before is_online / heartbeat / single-active-ride checks. A
    // driver in status='pending_verification' (or any other non-
    // approved status) must be rejected — this prevents an attacker
    // who only completed basic onboarding from accepting real rides.
    // Service contract: surface the rpcError + rpcPayload so the UI
    // can show "Tu cuenta aún no está aprobada — admin lo está
    // revisando" instead of a generic 'rpc_error'.
    it('throws driver_not_approved with status payload when RPC rejects unapproved driver (DRV-001)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          error: 'driver_not_approved',
          driver_status: 'pending_verification',
        },
        error: null,
      });

      try {
        await driverService.acceptRide('r-1', 'd-1');
        throw new Error('expected rejection');
      } catch (err) {
        expect((err as Error).message).toBe('driver_not_approved');
        const enriched = err as Error & {
          rpcError?: string;
          rpcPayload?: Record<string, unknown>;
        };
        expect(enriched.rpcError).toBe('driver_not_approved');
        expect(enriched.rpcPayload).toMatchObject({ driver_status: 'pending_verification' });
      }
    });
  });

  // ==================== updateRideStatus ====================
  //
  // BUG-244: routed through update_ride_status_v2 RPC for proximity gate
  // on arrived_at_pickup / arrived_at_destination. The service ALSO
  // does a follow-up SELECT on rides for delivery-mode notifications.
  describe('updateRideStatus', () => {
    it('routes through update_ride_status_v2 RPC for arrived_at_pickup', async () => {
      // RPC succeeds (not gated, no proximity issue)
      mockRpc.mockResolvedValueOnce({ data: { success: true }, error: null });

      // Follow-up SELECT for delivery notifications: select('customer_id, ride_mode').eq().single()
      const followUpChain = createMockQueryChain();
      followUpChain.single.mockResolvedValue({
        data: { customer_id: 'u-1', ride_mode: 'passenger' },
        error: null,
      });
      mockFrom.mockReturnValueOnce(followUpChain);

      await driverService.updateRideStatus('r-1', 'arrived_at_pickup' as any);

      expect(mockRpc).toHaveBeenCalledWith('update_ride_status_v2', expect.objectContaining({
        p_ride_id: 'r-1',
        p_new_status: 'arrived_at_pickup',
      }));
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

    // DRV-003 (security audit 2026-05-23, Driver fraud kill chain):
    // Migration 00289 adds trigger trg_rides_validate_actuals that
    // RAISEs when actual_distance_m / actual_duration_s exceed
    // absolute caps (200km / 8h) or relative caps (2x distance
    // estimate / 3x duration estimate). complete_ride_and_pay's
    // UPDATE of rides hits that trigger before the wallet debit,
    // so the entire RPC transaction rolls back. The error bubbles
    // up to the client as a generic supabase error with the RAISE
    // message in `message`.

    it('throws when complete_ride_and_pay UPDATE hits trg_rides_validate_actuals — distance > 200km absolute cap (DRV-003a)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message: 'actual_distance_m exceeds 200km absolute limit (got 999999 m)',
          code: 'P0001',
        },
      });

      await expect(
        driverService.completeRide({
          rideId: 'r-1',
          driverId: 'd-1',
          actualDistanceM: 999999,
          actualDurationS: 600,
        }),
      ).rejects.toThrow(/exceeds 200km absolute limit/);
    });

    it('throws when complete_ride_and_pay UPDATE hits trg_rides_validate_actuals — duration > 3x estimate (DRV-003b)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message:
            'actual_duration_s (3600) exceeds 3x estimate (600 s). Cap: 1800 s. Manual review required.',
          code: 'P0001',
        },
      });

      await expect(
        driverService.completeRide({
          rideId: 'r-1',
          driverId: 'd-1',
          actualDistanceM: 2500,
          actualDurationS: 3600,
        }),
      ).rejects.toThrow(/exceeds 3x estimate/);
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
    it('runs the coarse eligibility precheck and then accept_ride_v2 when eligible', async () => {
      mockRpc
        .mockResolvedValueOnce({ data: true, error: null })                                // check_accept_ride_eligibility (coarse)
        .mockResolvedValueOnce({ data: { success: true, ride_id: 'r-1' }, error: null });  // accept_ride_v2

      const rideChain = createMockQueryChain();
      rideChain.single.mockResolvedValue({
        data: {
          id: 'r-1', driver_id: 'd-1', status: 'accepted', ride_mode: 'passenger',
          pickup_lat: 4.6, pickup_lng: -74.08, dropoff_lat: 4.7, dropoff_lng: -74.09,
        },
        error: null,
      });
      mockFrom.mockReturnValueOnce(rideChain);

      const result = await driverService.acceptRideWithEligibility('r-1', 'd-1');

      expect(mockRpc).toHaveBeenNthCalledWith(1, 'check_accept_ride_eligibility', { p_driver_id: 'd-1' });
      expect(mockRpc).toHaveBeenNthCalledWith(2, 'accept_ride_v2', { p_ride_id: 'r-1', p_driver_id: 'd-1' });
      expect(result).toBeDefined();
    });

    it('throws when the coarse precheck reports ineligible', async () => {
      mockRpc.mockResolvedValueOnce({ data: false, error: null });

      await expect(
        driverService.acceptRideWithEligibility('r-1', 'd-1'),
      ).rejects.toThrow('No puedes aceptar viajes: tu cuenta tiene un saldo negativo pendiente.');
    });

    it('falls through to accept_ride_v2 if the precheck RPC errors (real gate is inside the RPC)', async () => {
      mockRpc
        .mockResolvedValueOnce({ data: null, error: { message: 'precheck transient', code: 'X' } })
        .mockResolvedValueOnce({ data: { success: true, ride_id: 'r-1' }, error: null });

      const rideChain = createMockQueryChain();
      rideChain.single.mockResolvedValue({
        data: {
          id: 'r-1', driver_id: 'd-1', status: 'accepted', ride_mode: 'passenger',
          pickup_lat: 0, pickup_lng: 0, dropoff_lat: 0, dropoff_lng: 0,
        },
        error: null,
      });
      mockFrom.mockReturnValueOnce(rideChain);

      const result = await driverService.acceptRideWithEligibility('r-1', 'd-1');
      expect(result.status).toBe('accepted');
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
