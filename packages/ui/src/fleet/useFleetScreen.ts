// ============================================================
// TriciGo — what the fleet screen shows, in both apps
// Reads the fleets the user drives for and the fleet they own as
// one numbered load (see packages/utils/src/fleet/corporateScreen.ts).
// This package has no router, so each route calls its own
// useRefreshOnFocus with `reload`.
// ============================================================

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { fleetService } from '@tricigo/api';
import type { FleetInviteSend } from '@tricigo/types';
import { logger } from '@tricigo/utils';
import {
  corporateReducer,
  deriveCorporateView,
  initialCorporateState,
  type CorporateAction,
} from '@tricigo/utils/fleet/corporateScreen';

export function useFleetScreen(userId: string | undefined) {
  const [state, dispatch] = useReducer(corporateReducer, initialCorporateState);
  const [refreshing, setRefreshing] = useState(false);
  // The invitation SMS the server sent for the owner's fleet. null is unknown
  // (the read failed or has not finished), never "nothing was sent".
  const [sends, setSends] = useState<FleetInviteSend[] | null>(null);
  const nextLoad = useRef(0);

  // Reads both lookups as a numbered load. A failed read keeps its last
  // value, and only the latest load applies, so a slow older one cannot
  // overwrite a newer result.
  const runLoad = useCallback(
    async (start: (load: number) => CorporateAction) => {
      if (!userId) {
        setRefreshing(false);
        return;
      }
      const load = nextLoad.current++;
      dispatch(start(load));
      const ownedFleetRead = fleetService.getFleetByOwner(userId);
      const [memberships, ownedFleet, sendsRead] = await Promise.allSettled([
        fleetService.getMembershipsForDriver(userId),
        ownedFleetRead,
        // The fleet id is known only once the owned fleet has been read.
        ownedFleetRead.then((owned) => (owned ? fleetService.getInviteSends(owned.fleet.id) : null)),
      ]);
      if (memberships.status === 'rejected') {
        logger.warn('[Corporate] Failed to load fleet memberships', { error: String(memberships.reason) });
      }
      if (ownedFleet.status === 'rejected') {
        logger.warn('[Corporate] Failed to load owned fleet', { error: String(ownedFleet.reason) });
      } else if (sendsRead.status === 'rejected') {
        logger.warn('[Corporate] Failed to load fleet invite sends', { error: String(sendsRead.reason) });
      }
      // Only the latest load applies, here as in the reducer.
      if (load === nextLoad.current - 1) {
        setSends(sendsRead.status === 'fulfilled' ? sendsRead.value : null);
      }
      dispatch({ type: 'load_settled', load, memberships, ownedFleet });
    },
    [userId],
  );

  const reload = useCallback(() => runLoad((load) => ({ type: 'load_started', load })), [runLoad]);

  // The request exists now, so "no fleet" is no longer known: read it back.
  const requestSubmitted = useCallback(() => {
    void runLoad((load) => ({ type: 'request_submitted', load }));
  }, [runLoad]);

  const pullToRefresh = useCallback(() => {
    setRefreshing(true);
    void reload();
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The pull-to-refresh spinner stops once no load is running.
  useEffect(() => {
    if (state.load === null) setRefreshing(false);
  }, [state.load]);

  return { view: deriveCorporateView(state), sends, refreshing, reload, pullToRefresh, requestSubmitted };
}

export type FleetScreen = ReturnType<typeof useFleetScreen>;
