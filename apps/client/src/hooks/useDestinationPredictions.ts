import { useEffect, useState, useRef, useCallback } from 'react';
import { rideService } from '@tricigo/api';
import {
  clusterDestinations,
  scorePredictions,
  type PredictedDestination,
  type RideHistoryEntry,
} from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import {
  getCachedPredictions,
  cachePredictions,
  invalidatePredictionCache,
} from '@/services/predictionCache';

const MIN_RIDES = 3;

export function useDestinationPredictions() {
  const userId = useAuthStore((s) => s.user?.id);
  const [predictions, setPredictions] = useState<PredictedDestination[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const lastHourRef = useRef<number>(-1);
  const clustersRef = useRef<ReturnType<typeof clusterDestinations> | null>(null);
  const rideCountRef = useRef(0);

  const computePredictions = useCallback(async (forceRefresh = false) => {
    if (!userId) return;

    setIsLoading(true);
    try {
      // Fetch completed rides for clustering
      const rides = await rideService.getRideHistoryFiltered({
        userId,
        status: ['completed'],
        pageSize: 100,
      });

      rideCountRef.current = rides.length;

      if (rides.length < MIN_RIDES) {
        setPredictions([]);
        setIsLoading(false);
        return;
      }

      // Check cache first (unless force refresh)
      if (!forceRefresh) {
        const cached = await getCachedPredictions(rides.length);
        if (cached) {
          setPredictions(cached);
          // Still compute clusters for re-scoring by hour
          const entries: RideHistoryEntry[] = rides.map((r) => ({
            dropoff_latitude: r.dropoff_location.latitude,
            dropoff_longitude: r.dropoff_location.longitude,
            dropoff_address: r.dropoff_address,
            created_at: r.created_at,
            status: r.status,
          }));
          clustersRef.current = clusterDestinations(entries);
          lastHourRef.current = new Date().getHours();
          setIsLoading(false);
          return;
        }
      }

      // Map to RideHistoryEntry format
      const entries: RideHistoryEntry[] = rides.map((r) => ({
        dropoff_latitude: r.dropoff_location.latitude,
        dropoff_longitude: r.dropoff_location.longitude,
        dropoff_address: r.dropoff_address,
        created_at: r.created_at,
        status: r.status,
      }));

      const clusters = clusterDestinations(entries);
      clustersRef.current = clusters;

      const currentHour = new Date().getHours();
      lastHourRef.current = currentHour;

      const scored = scorePredictions(clusters, currentHour);
      setPredictions(scored);

      // Save to cache
      await cachePredictions(scored, rides.length);
    } catch {
      // Fail silently — predictions are optional
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  // Initial load
  useEffect(() => {
    computePredictions();
  }, [computePredictions]);

  // Re-score when the hour changes (check every minute)
  useEffect(() => {
    const interval = setInterval(() => {
      const currentHour = new Date().getHours();
      if (currentHour !== lastHourRef.current && clustersRef.current) {
        lastHourRef.current = currentHour;
        const scored = scorePredictions(clustersRef.current, currentHour);
        setPredictions(scored);
        // Update cache with new scores
        cachePredictions(scored, rideCountRef.current).catch(() => {});
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, []);

  const refreshPredictions = useCallback(() => {
    invalidatePredictionCache().catch(() => {});
    computePredictions(true);
  }, [computePredictions]);

  return { predictions, isLoading, refreshPredictions };
}
