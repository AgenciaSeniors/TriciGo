// ============================================================
// TriciGo — Ride history coordinate shape
//
// R3-01 (QA round 3, 2026-11-20): the home card "¿Volver a [destino]?"
// reads the last completed ride from `getRideHistoryFiltered` and hands
// `dropoff_location` to the ride draft. PostgREST serialises geography
// columns as WKB hex strings, so the draft got a string, the estimate saw
// NaN and the rider got "Ubicación inválida". History rows must carry
// GeoPoint objects, like every other ride the services return.
// ============================================================

import { describe, it, expect, vi, beforeEach, assert } from 'vitest';

// ─── Supabase Mock ───────────────────────────────────────────
const mockGetUser = vi.fn();
const mockRpc = vi.fn();

function chainable(terminalValue: { data: unknown; error: unknown } = { data: null, error: null }) {
  const obj: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => obj;
  obj.select = vi.fn(self);
  obj.insert = vi.fn(self);
  obj.update = vi.fn(self);
  obj.delete = vi.fn(self);
  obj.eq = vi.fn(self);
  obj.neq = vi.fn(self);
  obj.gt = vi.fn(self);
  obj.gte = vi.fn(self);
  obj.lte = vi.fn(self);
  obj.in = vi.fn(self);
  obj.range = vi.fn(self);
  obj.is = vi.fn(self);
  obj.limit = vi.fn(self);
  obj.order = vi.fn(self);
  obj.single = vi.fn().mockResolvedValue(terminalValue);
  obj.maybeSingle = vi.fn().mockResolvedValue(terminalValue);
  obj.then = vi.fn((resolve: (v: unknown) => void) => resolve(terminalValue));
  return obj;
}

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

vi.mock('@tricigo/utils', () => ({
  haversineDistance: vi.fn().mockReturnValue(3000),
  estimateRoadDistance: vi.fn().mockReturnValue(3900),
  estimateDuration: vi.fn().mockReturnValue(600),
  cupToTrcCentavos: vi.fn().mockImplementation((cup: number, rate: number) => Math.round(cup / rate)),
  calculateBaseFare: vi.fn().mockReturnValue({ fare: 500, minFareApplied: false }),
  calculateCargoFare: vi.fn().mockReturnValue({ fare: 800, minFareApplied: false }),
  applySurge: vi.fn().mockImplementation((fare: number, mult: number) => Math.round(fare * mult)),
  matchPricingRule: vi.fn().mockReturnValue(null),
  calculateFareRange: vi.fn().mockReturnValue({
    minFareCup: 400, maxFareCup: 600, minFareTrc: 4, maxFareTrc: 6,
  }),
  maskPhone: vi.fn().mockImplementation((p: string) => p.replace(/.{4}$/, '****')),
  isLocationInCuba: vi.fn().mockReturnValue(true),
  fetchRoute: vi.fn().mockResolvedValue({ distance_m: 3900, duration_s: 600 }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  DEFAULT_EXCHANGE_RATE: 300,
  calculateTripDuration: vi.fn().mockReturnValue(600),
  cupToTrc: vi.fn().mockImplementation((cup: number) => Math.round(cup / 300)),
}));

import { rideService } from '../services/ride.service';

// A geography column as PostgREST actually serialises it.
const WKB_HEX = '0101000020E6100000A167B3EA73985CC0D34D6210585A3740';

function rideRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ride-1',
    status: 'completed',
    service_type: 'moto_standard',
    pickup_address: 'El Capitolio',
    dropoff_address: 'Hotel Nacional de Cuba',
    pickup_location: WKB_HEX,
    dropoff_location: WKB_HEX,
    pickup_lat: 23.1357,
    pickup_lng: -82.3666,
    dropoff_lat: 23.1431,
    dropoff_lng: -82.3815,
    ...overrides,
  };
}

beforeEach(() => {
  tableChains = {};
  vi.clearAllMocks();
});

describe('getRideHistoryFiltered', () => {
  it('returns dropoff_location as a GeoPoint so "Volver a" can price the trip', async () => {
    tableChains = { rides: chainable({ data: [rideRow()], error: null }) };

    const [ride] = await rideService.getRideHistoryFiltered({ userId: 'u1', pageSize: 1, status: ['completed'] });
    assert(ride);

    expect(ride.dropoff_location).toEqual({ latitude: 23.1431, longitude: -82.3815 });
  });

  it('returns pickup_location as a GeoPoint too', async () => {
    tableChains = { rides: chainable({ data: [rideRow()], error: null }) };

    const [ride] = await rideService.getRideHistoryFiltered({ userId: 'u1' });
    assert(ride);

    expect(ride.pickup_location).toEqual({ latitude: 23.1357, longitude: -82.3666 });
  });

  it('keeps the rest of the row', async () => {
    tableChains = { rides: chainable({ data: [rideRow()], error: null }) };

    const [ride] = await rideService.getRideHistoryFiltered({ userId: 'u1' });
    assert(ride);

    expect(ride.dropoff_address).toBe('Hotel Nacional de Cuba');
    expect(ride.service_type).toBe('moto_standard');
  });

  it('returns an empty list when there are no rides', async () => {
    tableChains = { rides: chainable({ data: [], error: null }) };

    await expect(rideService.getRideHistoryFiltered({ userId: 'u1' })).resolves.toEqual([]);
  });
});

describe('getRideHistory', () => {
  it('returns GeoPoints as well', async () => {
    tableChains = { rides: chainable({ data: [rideRow()], error: null }) };

    const [ride] = await rideService.getRideHistory('u1', 0, 10);
    assert(ride);

    expect(ride.dropoff_location).toEqual({ latitude: 23.1431, longitude: -82.3815 });
  });
});
