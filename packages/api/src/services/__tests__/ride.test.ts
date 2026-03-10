import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockSingle = vi.fn();
const mockSelect = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockSingle })) })) }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { rideService } from '../ride.service';

const TRICICLO_CONFIG = {
  id: 'config-1',
  slug: 'triciclo_basico',
  name_es: 'Triciclo Básico',
  name_en: 'Basic Tricycle',
  base_fare_cup: 2000, // 20 CUP
  per_km_rate_cup: 1000, // 10 CUP/km
  per_minute_rate_cup: 500, // 5 CUP/min
  min_fare_cup: 3000, // 30 CUP minimum
  max_passengers: 2,
  icon_name: 'triciclo',
  is_active: true,
};

const MOTO_CONFIG = {
  ...TRICICLO_CONFIG,
  id: 'config-2',
  slug: 'moto_standard',
  name_es: 'Moto Estándar',
  base_fare_cup: 1500,
  per_km_rate_cup: 800,
  per_minute_rate_cup: 400,
  min_fare_cup: 2500,
};

describe('rideService.getLocalFareEstimate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calculates fare for triciclo between Capitolio and Hotel Nacional', async () => {
    // Set up mock to return triciclo config
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: TRICICLO_CONFIG, error: null }),
          }),
        }),
      }),
    });

    const estimate = await rideService.getLocalFareEstimate({
      service_type: 'triciclo_basico',
      pickup_lat: 23.1352,  // Capitolio
      pickup_lng: -82.3599,
      dropoff_lat: 23.1375, // Hotel Nacional
      dropoff_lng: -82.3964,
    });

    expect(estimate.service_type).toBe('triciclo_basico');
    expect(estimate.estimated_fare_cup).toBeGreaterThan(0);
    expect(estimate.estimated_distance_m).toBeGreaterThan(0);
    expect(estimate.estimated_duration_s).toBeGreaterThan(0);
    expect(estimate.surge_multiplier).toBe(1.0);
    expect(estimate.pricing_rule_id).toBe('config-1');
  });

  it('respects min_fare_cup for very short distances', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: TRICICLO_CONFIG, error: null }),
          }),
        }),
      }),
    });

    // Very short distance — same location
    const estimate = await rideService.getLocalFareEstimate({
      service_type: 'triciclo_basico',
      pickup_lat: 23.1352,
      pickup_lng: -82.3599,
      dropoff_lat: 23.1353, // ~10m away
      dropoff_lng: -82.3599,
    });

    // Should enforce minimum fare of 3000 centavos (30 CUP)
    expect(estimate.estimated_fare_cup).toBeGreaterThanOrEqual(TRICICLO_CONFIG.min_fare_cup);
  });

  it('different service types produce different fares', async () => {
    // First call: triciclo
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: TRICICLO_CONFIG, error: null }),
          }),
        }),
      }),
    });

    const triciEstimate = await rideService.getLocalFareEstimate({
      service_type: 'triciclo_basico',
      pickup_lat: 23.1352,
      pickup_lng: -82.3599,
      dropoff_lat: 23.1375,
      dropoff_lng: -82.3964,
    });

    // Second call: moto
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: MOTO_CONFIG, error: null }),
          }),
        }),
      }),
    });

    const motoEstimate = await rideService.getLocalFareEstimate({
      service_type: 'moto_standard',
      pickup_lat: 23.1352,
      pickup_lng: -82.3599,
      dropoff_lat: 23.1375,
      dropoff_lng: -82.3964,
    });

    // Triciclo and moto should have different fares
    expect(triciEstimate.estimated_fare_cup).not.toBe(motoEstimate.estimated_fare_cup);
    // Moto should be cheaper (lower rates) but faster
    expect(motoEstimate.estimated_duration_s).toBeLessThan(triciEstimate.estimated_duration_s);
  });

  it('throws when service config fetch fails', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'Not found', code: 'PGRST116' },
            }),
          }),
        }),
      }),
    });

    await expect(
      rideService.getLocalFareEstimate({
        service_type: 'triciclo_basico',
        pickup_lat: 23.1352,
        pickup_lng: -82.3599,
        dropoff_lat: 23.1375,
        dropoff_lng: -82.3964,
      }),
    ).rejects.toBeDefined();
  });
});
