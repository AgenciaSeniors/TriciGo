'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { rideService } from '@tricigo/api';
import {
  clusterDestinations,
  scorePredictions,
  type PredictedDestination,
  type RideHistoryEntry,
} from '@tricigo/utils';

const MIN_RIDES = 3;
const CACHE_KEY = 'tricigo_destination_predictions';

/**
 * Web port of the mobile client's `useDestinationPredictions`.
 * Clusters the rider's completed-ride dropoffs and scores them by
 * frequency + time-of-day, re-scoring when the hour changes. Cached in
 * localStorage keyed by ride count so we don't refetch on every mount.
 */
export function useDestinationPredictions(userId: string | undefined) {
  const [predictions, setPredictions] = useState<PredictedDestination[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const lastHourRef = useRef<number>(-1);
  const clustersRef = useRef<ReturnType<typeof clusterDestinations> | null>(null);
  const rideCountRef = useRef(0);

  const readCache = useCallback((rideCount: number): PredictedDestination[] | null => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { rideCount: number; predictions: PredictedDestination[] };
      return parsed.rideCount === rideCount ? parsed.predictions : null;
    } catch {
      return null;
    }
  }, []);

  const writeCache = useCallback((rideCount: number, preds: PredictedDestination[]) => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ rideCount, predictions: preds }));
    } catch {
      /* quota — ignore */
    }
  }, []);

  const computePredictions = useCallback(async (forceRefresh = false) => {
    if (!userId) return;
    setIsLoading(true);
    try {
      const rides = await rideService.getRideHistoryFiltered({
        userId,
        status: ['completed'],
        pageSize: 100,
      });
      rideCountRef.current = rides.length;

      if (rides.length < MIN_RIDES) {
        setPredictions([]);
        return;
      }

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

      if (!forceRefresh) {
        const cached = readCache(rides.length);
        if (cached) {
          setPredictions(cached);
          return;
        }
      }

      const scored = scorePredictions(clusters, currentHour);
      setPredictions(scored);
      writeCache(rides.length, scored);
    } catch {
      /* predictions are optional — fail silently */
    } finally {
      setIsLoading(false);
    }
  }, [userId, readCache, writeCache]);

  useEffect(() => {
    computePredictions();
  }, [computePredictions]);

  // Re-score when the hour changes (check every minute).
  useEffect(() => {
    const interval = setInterval(() => {
      const currentHour = new Date().getHours();
      if (currentHour !== lastHourRef.current && clustersRef.current) {
        lastHourRef.current = currentHour;
        const scored = scorePredictions(clustersRef.current, currentHour);
        setPredictions(scored);
        writeCache(rideCountRef.current, scored);
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [writeCache]);

  return { predictions, isLoading };
}
