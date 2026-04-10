// ============================================================
// TriciGo — Ride Service Integration Tests
// Tests critical ride flows through the service layer
// with mocked Supabase client.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Supabase Mock ───────────────────────────────────────────
const mockGetUser = vi.fn();
const mockRpc = vi.fn();

/**
 * Creates a fully chainable mock object that mimics the Supabase
 * query builder. Every method returns `this` (the same object),
 * except terminal methods (single / maybeSingle) which resolve
 * to {data, error} by default.
 */
function chainable(terminalValue: { data: unknown; error: unknown } = { data: null, error: null }) {
  const obj: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => obj;
  obj.select = vi.fn(self);
  obj.insert = vi.fn(self);
  obj.update = vi.fn(self);
  obj.delete = vi.fn(self);
  obj.eq = vi.fn(self);
  obj.neq = vi.fn(self);
  obj.order = vi.fn(self);
  obj.limit = vi.fn(self);
  obj.range = vi.fn(self);
  obj.like = vi.fn(self);
  obj.is = vi.fn(self);
  obj.gte = vi.fn(self);
  obj.lte = vi.fn(self);
  obj.single = vi.fn().mockResolvedValue(terminalValue);
  obj.maybeSingle = vi.fn().mockResolvedValue(terminalValue);
  // When used as a thenable (await without terminal), resolve directly
  obj.then = vi.fn((resolve: (v: unknown) => void) => resolve(terminalValue));
  return obj;
}

// Table-specific chains that can be configured per-test
let tableChains: Record<string, ReturnType<typeof chainable>> = {};

const mockFrom = vi.fn().mockImplementation((table: string) => {
  if (tableChains[table]) return tableChains[table];
  return chainable();
});

vi.mock('../client', () => ({
  getSupabaseClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

// Mock utilities used by ride service
vi.mock('@tricigo/utils', () => ({
  haversineDistance: vi.fn().mockReturnValue(3000),
  estimateRoadDistance: vi.fn().mockReturnValue(3900),
  estimateDuration: vi.fn().mockReturnValue(600),
  cupToTrcCentavos: vi.fn().mockImplementation((cup: number, rate: number) =>
    Math.round(cup / rate),
  ),
  calculateBaseFare: vi.fn().mockReturnValue({ fare: 500, minFareApplied: false }),
  calculateCargoFare: vi.fn().mockReturnValue({ fare: 800, minFareApplied: false }),
  applySurge: vi.fn().mockImplementation((fare: number, mult: number) =>
    Math.round(fare * mult),
  ),
  matchPricingRule: vi.fn().mockReturnValue(null),
  calculateFareRange: vi.fn().mockReturnValue({
    minFareCup: 400, maxFareCup: 600,
    minFareTrc: 4, maxFareTrc: 6,
  }),
  maskPhone: vi.fn().mockImplementation((p: string) => p.replace(/.{4}$/, '****')),
  isLocationInCuba: vi.fn().mockReturnValue(true),
  fetchRoute: vi.fn().mockResolvedValue({ distance_m: 3900, duration_s: 600 }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  DEFAULT_EXCHANGE_RATE: 300,
  calculateTripDuration: vi.fn().mockReturnValue(600),
  cupToTrc: vi.fn().mockImplementation((cup: number) => Math.round(cup / 300)),
}));

// Mock sibling services
vi.mock('./exchange-rate.service', () => ({
  exchangeRateService: {
    getUsdCupRate: vi.fn().mockResolvedValue(120),
  },
}));

vi.mock('./corporate.service', () => ({
  corporateService: {
    validateCorporateRide: vi.fn().mockResolvedValue({ valid: true }),
    recordCorporateRide: vi.fn(),
  },
}));

vi.mock('./matching.service', () => ({
  matchingService: {
    findBestDrivers: vi.fn().mockResolvedValue([]),
    updateDriverScore: vi.fn(),
  },
}));

vi.mock('./notification.service', () => ({
  notificationService: {
    sendPush: vi.fn(),
    notifyDriver: vi.fn(),
    notifyRider: vi.fn(),
  },
}));

// Import after mocks
import { rideService } from '../services/ride.service';

// Valid Cuba coordinates for testing
const HAVANA_PICKUP = { lat: 23.1136, lng: -82.3666, addr: 'Calle 23, La Habana' };
const HAVANA_DROPOFF = { lat: 23.1445, lng: -82.3593, addr: 'Malecón, La Habana' };

describe('Ride Service Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tableChains = {};
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'test-user-id' } },
    });
  });

  // ─── createRide ───────────────────────────────────────────

  describe('createRide', () => {
    it('should create a ride with valid params and return Ride object', async () => {
      const mockRide = {
        id: 'ride-001',
        customer_id: 'test-user-id',
        status: 'searching',
        service_type: 'triciclo_basico',
        payment_method: 'cash',
        pickup_address: HAVANA_PICKUP.addr,
        dropoff_address: HAVANA_DROPOFF.addr,
      };

      // Configure table chains for the createRide flow
      tableChains['rides'] = chainable({ data: mockRide, error: null });
      // For dynamic surge + experiment RPCs
      mockRpc.mockResolvedValue({ data: 1.0, error: null });

      const result = await rideService.createRide({
        service_type: 'triciclo_basico',
        payment_method: 'cash',
        pickup_latitude: HAVANA_PICKUP.lat,
        pickup_longitude: HAVANA_PICKUP.lng,
        pickup_address: HAVANA_PICKUP.addr,
        dropoff_latitude: HAVANA_DROPOFF.lat,
        dropoff_longitude: HAVANA_DROPOFF.lng,
        dropoff_address: HAVANA_DROPOFF.addr,
      });

      expect(result).toBeDefined();
      expect(result.id).toBe('ride-001');
      expect(result.status).toBe('searching');
    });

    it('should reject ride with pickup outside Cuba (fails Zod validation)', async () => {
      // Cuba lat bounds in schema: 19.5-23.5, lng: -85 to -74
      // 40.7128 lat is outside Cuba bounds, Zod rejects it before isLocationInCuba
      await expect(
        rideService.createRide({
          service_type: 'triciclo_basico',
          payment_method: 'cash',
          pickup_latitude: 40.7128,   // New York - outside Cuba lat bounds
          pickup_longitude: -74.006,  // Also outside Cuba lng bounds
          pickup_address: 'New York, USA',
          dropoff_latitude: HAVANA_DROPOFF.lat,
          dropoff_longitude: HAVANA_DROPOFF.lng,
          dropoff_address: HAVANA_DROPOFF.addr,
        }),
      ).rejects.toThrow();
    });

    it('should reject unauthenticated user', async () => {
      mockGetUser.mockResolvedValueOnce({
        data: { user: null },
      });
      mockRpc.mockResolvedValue({ data: 1.0, error: null });

      await expect(
        rideService.createRide({
          service_type: 'triciclo_basico',
          payment_method: 'cash',
          pickup_latitude: HAVANA_PICKUP.lat,
          pickup_longitude: HAVANA_PICKUP.lng,
          pickup_address: HAVANA_PICKUP.addr,
          dropoff_latitude: HAVANA_DROPOFF.lat,
          dropoff_longitude: HAVANA_DROPOFF.lng,
          dropoff_address: HAVANA_DROPOFF.addr,
        }),
      ).rejects.toThrow();
    });
  });

  // ─── getLocalFareEstimate ─────────────────────────────────

  describe('getLocalFareEstimate', () => {
    it('should return a fare estimate for a valid route', async () => {
      const mockServiceConfig = {
        id: 'svc-001',
        slug: 'triciclo_basico',
        base_fare_cup: 100,
        per_km_rate_cup: 50,
        per_minute_rate_cup: 10,
        min_fare_cup: 200,
        is_active: true,
      };

      // service_type_configs query
      tableChains['service_type_configs'] = chainable({ data: mockServiceConfig, error: null });
      // pricing_rules query returns array
      tableChains['pricing_rules'] = chainable({ data: [], error: null });
      // surge_zones query
      tableChains['surge_zones'] = chainable({ data: [], error: null });
      // pricing_experiments
      tableChains['pricing_experiments'] = chainable({ data: null, error: null });
      // trip_insurance_configs
      tableChains['trip_insurance_configs'] = chainable({ data: null, error: null });

      // Dynamic surge RPC
      mockRpc.mockResolvedValueOnce({ data: 1.0, error: null });

      mockGetUser.mockResolvedValueOnce({
        data: { user: { id: 'test-user-id' } },
      });

      const result = await rideService.getLocalFareEstimate({
        service_type: 'triciclo_basico',
        pickup_lat: HAVANA_PICKUP.lat,
        pickup_lng: HAVANA_PICKUP.lng,
        dropoff_lat: HAVANA_DROPOFF.lat,
        dropoff_lng: HAVANA_DROPOFF.lng,
      });

      expect(result).toBeDefined();
      expect(result).toHaveProperty('estimated_fare_cup');
      expect(result).toHaveProperty('estimated_distance_m');
      expect(result).toHaveProperty('estimated_duration_s');
      expect(result).toHaveProperty('surge_multiplier');
    });
  });

  // ─── getRideWaypoints ─────────────────────────────────────

  describe('getRideWaypoints', () => {
    it('should return waypoints sorted by sort_order', async () => {
      const mockWaypoints = [
        { id: 'wp-1', ride_id: 'ride-001', sort_order: 1, address: 'Stop 1' },
        { id: 'wp-2', ride_id: 'ride-001', sort_order: 2, address: 'Stop 2' },
      ];

      const chain = chainable({ data: mockWaypoints, error: null });
      // Override order to resolve directly (it's the terminal call here)
      (chain.order as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockWaypoints,
        error: null,
      });
      tableChains['ride_waypoints'] = chain;

      const result = await rideService.getRideWaypoints('ride-001');

      expect(result).toHaveLength(2);
      expect(result[0].address).toBe('Stop 1');
      expect(result[1].address).toBe('Stop 2');
    });
  });

  // ─── addWaypointToActiveRide ──────────────────────────────

  describe('addWaypointToActiveRide', () => {
    it('should throw MAX_WAYPOINTS_REACHED when limit exceeded', async () => {
      const chain = chainable();
      // The limit() call is the terminal for "get existing waypoints"
      (chain.limit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [{ sort_order: 3 }],
        error: null,
      });
      tableChains['ride_waypoints'] = chain;

      await expect(
        rideService.addWaypointToActiveRide('ride-001', 'Stop 4', 23.12, -82.35),
      ).rejects.toThrow('MAX_WAYPOINTS_REACHED');
    });
  });

  // ─── createSplitInvite ────────────────────────────────────

  describe('createSplitInvite', () => {
    it('should reject split for non-tricicoin payment', async () => {
      tableChains['rides'] = chainable({
        data: { payment_method: 'cash', is_split: false },
        error: null,
      });

      await expect(
        rideService.createSplitInvite('ride-001', 'user-2', 'user-1', 50),
      ).rejects.toThrow('SPLIT_ONLY_TRICICOIN');
    });
  });
});
