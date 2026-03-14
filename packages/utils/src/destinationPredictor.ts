// ============================================================
// TriciGo — Destination Predictor
// Heuristic-based destination prediction from ride history.
// Clusters dropoff locations, scores by frequency + time-of-day.
// ============================================================

import { haversineDistance } from './geo';

// ─── Types ───

export interface RideHistoryEntry {
  dropoff_latitude: number;
  dropoff_longitude: number;
  dropoff_address: string;
  created_at: string;
  status: string;
}

export interface DestinationCluster {
  centroid: { latitude: number; longitude: number };
  /** Most recent address in this cluster */
  address: string;
  /** Total completed rides to this cluster */
  frequency: number;
  /** Count of rides per hour of day (0-23) */
  hourBuckets: number[];
  /** ISO timestamp of most recent ride */
  lastVisited: string;
  /** Computed relevance score */
  score: number;
}

export type PredictionReason = 'frequent' | 'time_pattern' | 'recent';

export interface PredictedDestination {
  address: string;
  latitude: number;
  longitude: number;
  score: number;
  reason: PredictionReason;
}

// ─── Clustering ───

/**
 * Cluster completed rides by dropoff location proximity.
 * Uses greedy clustering: each ride is merged into the nearest
 * existing cluster within `radiusM` meters, or creates a new cluster.
 */
export function clusterDestinations(
  rides: RideHistoryEntry[],
  radiusM = 200,
): DestinationCluster[] {
  const completed = rides.filter((r) => r.status === 'completed');
  if (completed.length === 0) return [];

  const clusters: DestinationCluster[] = [];

  for (const ride of completed) {
    const point = {
      latitude: ride.dropoff_latitude,
      longitude: ride.dropoff_longitude,
    };
    const hour = new Date(ride.created_at).getHours();

    // Find nearest existing cluster within radius
    let bestCluster: DestinationCluster | null = null;
    let bestDist = Infinity;

    for (const cluster of clusters) {
      const dist = haversineDistance(point, cluster.centroid);
      if (dist < bestDist && dist <= radiusM) {
        bestDist = dist;
        bestCluster = cluster;
      }
    }

    if (bestCluster) {
      // Merge into existing cluster — weighted centroid update
      const total = bestCluster.frequency + 1;
      bestCluster.centroid = {
        latitude:
          (bestCluster.centroid.latitude * bestCluster.frequency + point.latitude) / total,
        longitude:
          (bestCluster.centroid.longitude * bestCluster.frequency + point.longitude) / total,
      };
      bestCluster.frequency = total;
      bestCluster.hourBuckets[hour] = (bestCluster.hourBuckets[hour] ?? 0) + 1;

      // Keep most recent address and timestamp
      if (ride.created_at > bestCluster.lastVisited) {
        bestCluster.address = ride.dropoff_address;
        bestCluster.lastVisited = ride.created_at;
      }
    } else {
      // Create new cluster
      const hourBuckets = new Array(24).fill(0) as number[];
      hourBuckets[hour] = 1;
      clusters.push({
        centroid: { ...point },
        address: ride.dropoff_address,
        frequency: 1,
        hourBuckets,
        lastVisited: ride.created_at,
        score: 0,
      });
    }
  }

  // Sort by frequency descending
  clusters.sort((a, b) => b.frequency - a.frequency);
  return clusters;
}

// ─── Scoring ───

/**
 * Score destination clusters based on current hour of day.
 * Returns up to `limit` top predictions with score >= minScore.
 *
 * Scoring formula:
 *   score = (frequency × 2) + (hourBuckets[currentHour] × 5) + recencyBonus
 *
 * recencyBonus:
 *   - Last 7 days: +3
 *   - Last 30 days: +1
 *   - Older: +0
 */
export function scorePredictions(
  clusters: DestinationCluster[],
  currentHour: number,
  now = new Date(),
  limit = 5,
  minScore = 3,
): PredictedDestination[] {
  const nowMs = now.getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const scored: PredictedDestination[] = [];

  for (const cluster of clusters) {
    const lastVisitedMs = new Date(cluster.lastVisited).getTime();
    const ageMs = nowMs - lastVisitedMs;

    // Recency bonus
    let recencyBonus = 0;
    if (ageMs <= sevenDaysMs) {
      recencyBonus = 3;
    } else if (ageMs <= thirtyDaysMs) {
      recencyBonus = 1;
    }

    // Time-of-day weight
    const hourCount = cluster.hourBuckets[currentHour] ?? 0;

    const score = cluster.frequency * 2 + hourCount * 5 + recencyBonus;

    if (score < minScore) continue;

    // Determine reason
    let reason: PredictionReason;
    if (hourCount >= 2) {
      reason = 'time_pattern';
    } else if (cluster.frequency >= 3) {
      reason = 'frequent';
    } else {
      reason = 'recent';
    }

    scored.push({
      address: cluster.address,
      latitude: cluster.centroid.latitude,
      longitude: cluster.centroid.longitude,
      score,
      reason,
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}
