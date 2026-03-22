// ============================================================
// TriciGo — useOfflineSync Hook
// Processes the standalone offline queue (packages/utils)
// whenever network connectivity is restored.
// ============================================================

import { useEffect, useRef } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { offlineQueue } from '@tricigo/utils';
import { reviewService } from '@tricigo/api';

/**
 * Hook that listens for network restoration and flushes
 * the lightweight offline queue from @tricigo/utils.
 *
 * This complements the full offline mutation system in
 * @tricigo/api (initialized in AppProviders) by handling
 * simpler queued actions like reviews.
 *
 * Call once at the app root.
 */
export function useOfflineSync() {
  const processingRef = useRef(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && !processingRef.current) {
        processingRef.current = true;
        offlineQueue
          .processQueue({
            submitReview: async (params) => {
              await reviewService.submitReview(params as any);
            },
          })
          .finally(() => {
            processingRef.current = false;
          });
      }
    });
    return () => unsubscribe();
  }, []);
}
