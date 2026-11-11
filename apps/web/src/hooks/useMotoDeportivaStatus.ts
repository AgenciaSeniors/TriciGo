'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { motoDeportivaService } from '@tricigo/api';
import { motoDeportivaCard, type MotoDeportivaStatus } from '@tricigo/utils';

const POLL_MS = 30_000;

// One shared status for the selector: the card polls, while the estimate list
// only reads the last value when it builds its request. (No zustand in web.)
let current: MotoDeportivaStatus | null = null;
const listeners = new Set<() => void>();
function setStatusInStore(s: MotoDeportivaStatus | null) {
  current = s;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const getSnapshot = () => current;

/** Non-hook read for callbacks (estimates). False until the first successful poll. */
export function isMotoDeportivaRequestable(): boolean {
  return motoDeportivaCard(current).requestable;
}

/** Overwrite the shared status (e.g. after the server rejected the request). */
export function refreshMotoDeportivaStatus(s: MotoDeportivaStatus | null) {
  setStatusInStore(s);
}

export function useMotoDeportivaStatus(enabled: boolean) {
  const status = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const refetch = useCallback(async () => {
    if (!enabled) return;
    setStatusInStore(await motoDeportivaService.getStatus());
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    void refetch();
    const id = setInterval(() => void refetch(), POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void refetch(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refetch]);
  const setWaitlist = useCallback(async (join: boolean) => {
    const waiting = await motoDeportivaService.setWaitlist(join);
    if (current) setStatusInStore({ ...current, waiting });
  }, []);
  return { status, card: motoDeportivaCard(status), refetch, setWaitlist };
}
