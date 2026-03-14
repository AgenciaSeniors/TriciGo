import { describe, it, expect } from 'vitest';
import {
  clusterDestinations,
  scorePredictions,
  type RideHistoryEntry,
} from '../destinationPredictor';

// ─── Helpers ───

function makeRide(
  lat: number,
  lng: number,
  address: string,
  hourOfDay: number,
  daysAgo = 0,
): RideHistoryEntry {
  const d = new Date('2026-03-10T00:00:00Z');
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hourOfDay, 0, 0, 0);
  return {
    dropoff_latitude: lat,
    dropoff_longitude: lng,
    dropoff_address: address,
    created_at: d.toISOString(),
    status: 'completed',
  };
}

const OFFICE = { lat: 23.1375, lng: -82.3964 };
const HOME = { lat: 23.1210, lng: -82.3826 };
const GYM = { lat: 23.1352, lng: -82.3599 };

// ─── clusterDestinations ───

describe('clusterDestinations', () => {
  it('returns empty array for no rides', () => {
    expect(clusterDestinations([])).toEqual([]);
  });

  it('filters out non-completed rides', () => {
    const rides: RideHistoryEntry[] = [
      { ...makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8), status: 'canceled' },
    ];
    expect(clusterDestinations(rides)).toEqual([]);
  });

  it('creates one cluster for a single ride', () => {
    const rides = [makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8)];
    const clusters = clusterDestinations(rides);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.frequency).toBe(1);
    expect(clusters[0]!.address).toBe('Oficina');
    expect(clusters[0]!.hourBuckets[8]).toBe(1);
  });

  it('clusters rides within 200m into one cluster', () => {
    // Two points ~50m apart (same block)
    const rides = [
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina A', 8, 1),
      makeRide(OFFICE.lat + 0.0003, OFFICE.lng + 0.0002, 'Oficina B', 9, 0),
    ];
    const clusters = clusterDestinations(rides, 200);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.frequency).toBe(2);
    // Most recent address wins
    expect(clusters[0]!.address).toBe('Oficina B');
    expect(clusters[0]!.hourBuckets[8]).toBe(1);
    expect(clusters[0]!.hourBuckets[9]).toBe(1);
  });

  it('keeps rides >200m apart as separate clusters', () => {
    // OFFICE and HOME are ~1.7km apart
    const rides = [
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8),
      makeRide(HOME.lat, HOME.lng, 'Casa', 18),
    ];
    const clusters = clusterDestinations(rides, 200);
    expect(clusters).toHaveLength(2);
  });

  it('sorts clusters by frequency descending', () => {
    const rides = [
      makeRide(HOME.lat, HOME.lng, 'Casa', 18, 0),
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8, 1),
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8, 2),
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 9, 3),
    ];
    const clusters = clusterDestinations(rides);
    expect(clusters[0]!.address).toBe('Oficina');
    expect(clusters[0]!.frequency).toBe(3);
    expect(clusters[1]!.address).toBe('Casa');
    expect(clusters[1]!.frequency).toBe(1);
  });

  it('accumulates hour buckets correctly', () => {
    const rides = [
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8, 0),
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8, 1),
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 9, 2),
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8, 3),
    ];
    const clusters = clusterDestinations(rides);
    expect(clusters[0]!.hourBuckets[8]).toBe(3);
    expect(clusters[0]!.hourBuckets[9]).toBe(1);
    expect(clusters[0]!.hourBuckets[10]).toBe(0);
  });
});

// ─── scorePredictions ───

describe('scorePredictions', () => {
  const now = new Date('2026-03-10T08:00:00Z');

  it('returns empty for empty clusters', () => {
    expect(scorePredictions([], 8, now)).toEqual([]);
  });

  it('scores time-of-day pattern higher at matching hour', () => {
    // 10 rides to Office at 8am, 5 rides to Home at 6pm
    const officeRides = Array.from({ length: 10 }, (_, i) =>
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8, i),
    );
    const homeRides = Array.from({ length: 5 }, (_, i) =>
      makeRide(HOME.lat, HOME.lng, 'Casa', 18, i),
    );
    const clusters = clusterDestinations([...officeRides, ...homeRides]);

    // At 8am, Office should score highest
    const at8am = scorePredictions(clusters, 8, now);
    expect(at8am[0]!.address).toBe('Oficina');
    expect(at8am[0]!.reason).toBe('time_pattern');

    // At 6pm, Home should score highest
    const at6pm = scorePredictions(clusters, 18, now);
    expect(at6pm[0]!.address).toBe('Casa');
    expect(at6pm[0]!.reason).toBe('time_pattern');
  });

  it('assigns "frequent" reason for high-frequency clusters without hour match', () => {
    // 5 rides to Office spread across different hours, check at midnight
    const rides = [
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8, 0),
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 9, 1),
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 10, 2),
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 11, 3),
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 12, 4),
    ];
    const clusters = clusterDestinations(rides);
    const predictions = scorePredictions(clusters, 0, now); // midnight
    expect(predictions).toHaveLength(1);
    expect(predictions[0]!.reason).toBe('frequent');
  });

  it('applies recency bonus for recent rides', () => {
    // Cluster A: 3 rides, 2 days ago (recent)
    // Cluster B: 3 rides, 60 days ago (old)
    const recentRides = Array.from({ length: 3 }, (_, i) =>
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 14, i + 1),
    );
    const oldRides = Array.from({ length: 3 }, (_, i) =>
      makeRide(HOME.lat, HOME.lng, 'Casa', 14, 60 + i),
    );
    const clusters = clusterDestinations([...recentRides, ...oldRides]);
    const predictions = scorePredictions(clusters, 14, now);

    // Both have freq=3, but Office has recency bonus +3
    const officeP = predictions.find((p) => p.address === 'Oficina')!;
    const homeP = predictions.find((p) => p.address === 'Casa')!;
    expect(officeP.score).toBeGreaterThan(homeP.score);
  });

  it('filters out clusters with score below minScore', () => {
    // Single ride from 60 days ago at hour 14
    // score = (1 * 2) + (0 * 5) + 0 = 2 (below default minScore=3)
    const rides = [makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 14, 60)];
    const clusters = clusterDestinations(rides);
    const predictions = scorePredictions(clusters, 0, now);
    expect(predictions).toHaveLength(0);
  });

  it('limits results to specified limit', () => {
    // Create 10 distinct clusters with recent rides
    const rides = Array.from({ length: 10 }, (_, i) =>
      makeRide(23.1 + i * 0.01, -82.3 - i * 0.01, `Place ${i}`, 8, i),
    );
    const clusters = clusterDestinations(rides);
    const predictions = scorePredictions(clusters, 8, now, 3);
    expect(predictions.length).toBeLessThanOrEqual(3);
  });

  it('returns predictions sorted by score descending', () => {
    const officeRides = Array.from({ length: 8 }, (_, i) =>
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8, i),
    );
    const homeRides = Array.from({ length: 4 }, (_, i) =>
      makeRide(HOME.lat, HOME.lng, 'Casa', 8, i),
    );
    const gymRides = Array.from({ length: 2 }, (_, i) =>
      makeRide(GYM.lat, GYM.lng, 'Gym', 8, i),
    );
    const clusters = clusterDestinations([...officeRides, ...homeRides, ...gymRides]);
    const predictions = scorePredictions(clusters, 8, now);

    for (let i = 1; i < predictions.length; i++) {
      expect(predictions[i - 1]!.score).toBeGreaterThanOrEqual(predictions[i]!.score);
    }
  });

  it('handles all rides to same location', () => {
    const rides = Array.from({ length: 10 }, (_, i) =>
      makeRide(OFFICE.lat, OFFICE.lng, 'Oficina', 8, i),
    );
    const clusters = clusterDestinations(rides);
    const predictions = scorePredictions(clusters, 8, now);
    expect(predictions).toHaveLength(1);
    expect(predictions[0]!.score).toBeGreaterThan(0);
  });
});
