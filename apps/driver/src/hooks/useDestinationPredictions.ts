// ============================================================
// TriciGo Driver — useDestinationPredictions
// Brings the rider's destination-suggestions tier to the driver's
// destination search. RPC-first (get_destination_suggestions), with a
// fallback to the local destinationPredictor heuristic when the RPC is
// absent (migration not yet applied) or errors.
// ============================================================

import { useEffect, useState, useCallback } from 'react';
import { rideService, suggestionsService } from '@tricigo/api';
import {
  clusterDestinations,
  scorePredictions,
  type PredictedDestination,
  type RideHistoryEntry,
} from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';

const MIN_RIDES = 3;

export function useDestinationPredictions(
  near?: { latitude: number; longitude: number } | null,
) {
  const userId = useAuthStore((s) => s.user?.id);
  const [predictions, setPredictions] = useState<PredictedDestination[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const compute = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);
    try {
      // RPC-first: server-side suggestions (personal history + popular
      // fallback). Falls through to the local heuristic when the RPC is
      // absent (migration not yet applied) or errors.
      try {
        const rpc = await suggestionsService.getDestinationSuggestions({
          userId,
          lat: near?.latitude ?? null,
          lng: near?.longitude ?? null,
          hour: new Date().getHours(),
          limit: 5,
        });
        setPredictions(rpc);
        return;
      } catch {
        /* fall through to the local heuristic below */
      }

      const rides = await rideService.getRideHistoryFiltered({
        userId,
        status: ['completed'],
        pageSize: 100,
      });
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
      setPredictions(scorePredictions(clusterDestinations(entries), new Date().getHours()));
    } catch {
      /* predictions are optional — fail silently */
    } finally {
      setIsLoading(false);
    }
  }, [userId, near?.latitude, near?.longitude]);

  useEffect(() => {
    compute();
  }, [compute]);

  return { predictions, isLoading };
}
