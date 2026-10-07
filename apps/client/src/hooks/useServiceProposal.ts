import { useCallback, useEffect, useRef, useState } from 'react';
import { rideAssistService, type ServiceProposal } from '@tricigo/api';

/**
 * The vehicle-type change support proposed for this searching ride (00628), polled every 5 s
 * while `enabled`. null when there is none, when 00628 is not applied, or when a poll fails.
 * `dismiss(id)` hides a proposal the rider already answered, even if a poll that was in flight
 * still returns it.
 */
export function useServiceProposal(rideId: string | null, enabled: boolean) {
  const [proposal, setProposal] = useState<ServiceProposal | null>(null);
  const dismissedRef = useRef<Set<string>>(new Set());
  const activeRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!rideId) return;
    try {
      const next = await rideAssistService.getPendingProposal(rideId);
      if (!activeRef.current) return;
      setProposal(next && !dismissedRef.current.has(next.id) ? next : null);
    } catch {
      // Keep what is shown; the next poll retries.
    }
  }, [rideId]);

  useEffect(() => {
    activeRef.current = true;
    if (!enabled || !rideId) {
      setProposal(null);
      return () => {
        activeRef.current = false;
      };
    }
    void refresh();
    const id = setInterval(refresh, 5_000);
    return () => {
      activeRef.current = false;
      clearInterval(id);
    };
  }, [enabled, rideId, refresh]);

  const dismiss = useCallback((id: string) => {
    dismissedRef.current.add(id);
    setProposal((p) => (p?.id === id ? null : p));
  }, []);

  return { proposal, dismiss };
}
