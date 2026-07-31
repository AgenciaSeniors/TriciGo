// ============================================================
// TriciGo — Ride offer coordinate shape
//
// `getSearchingRides` feeds the driver's incoming-offer card. That card
// computes the distance to the pickup from `pickup_location.latitude`,
// so the rows it returns must carry GeoPoint objects — not the raw WKB
// hex strings PostgREST hands back for PostGIS geography columns.
//
// Without this, `pickupDistanceKm` is null forever and the card silently
// drops its "AL RECOGER X KM" segment: the driver decides whether to
// accept without knowing how far they must drive empty.
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

function offerRow(overrides: Record<string, unknown> = {}) {
  return {
    expires_at: '2026-07-31T12:01:00.000Z',
    rides: {
      id: 'ride-1',
      status: 'searching',
      pickup_location: WKB_HEX,
      dropoff_location: WKB_HEX,
      pickup_lat: 23.1357,
      pickup_lng: -82.3666,
      dropoff_lat: 23.1201,
      dropoff_lng: -82.4012,
      ...overrides,
    },
  };
}

beforeEach(() => {
  tableChains = {};
  vi.clearAllMocks();
});

describe('getSearchingRides', () => {
  it('returns pickup_location as a GeoPoint so the offer card can measure the distance', async () => {
    tableChains = { ride_offers: chainable({ data: [offerRow()], error: null }) };

    const [offer] = await rideService.getSearchingRides();
    assert(offer);

    expect(offer.pickup_location).toEqual({ latitude: 23.1357, longitude: -82.3666 });
  });

  it('returns dropoff_location as a GeoPoint too', async () => {
    tableChains = { ride_offers: chainable({ data: [offerRow()], error: null }) };

    const [offer] = await rideService.getSearchingRides();
    assert(offer);

    expect(offer.dropoff_location).toEqual({ latitude: 23.1201, longitude: -82.4012 });
  });

  it('keeps the offer window from ride_offers.expires_at', async () => {
    tableChains = { ride_offers: chainable({ data: [offerRow()], error: null }) };

    const [offer] = await rideService.getSearchingRides();
    assert(offer);

    expect(offer.offer_expires_at).toBe('2026-07-31T12:01:00.000Z');
  });

  it('falls back to 0 when a row has no synced lat/lng', async () => {
    tableChains = {
      ride_offers: chainable({
        data: [offerRow({ pickup_lat: null, pickup_lng: null })],
        error: null,
      }),
    };

    const [offer] = await rideService.getSearchingRides();
    assert(offer);

    expect(offer.pickup_location).toEqual({ latitude: 0, longitude: 0 });
  });
});
