import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { motoDeportivaService } from '@tricigo/api';
import { motoDeportivaCard, type MotoDeportivaStatus } from '@tricigo/utils';
import { useRefreshOnFocus } from './useRefreshOnFocus';

const POLL_MS = 30_000;

// One shared status for every screen that needs it: the selection list polls,
// while useRideActions only reads the last value when it builds its estimate list.
interface MotoDeportivaState {
  status: MotoDeportivaStatus | null;
  setStatus: (s: MotoDeportivaStatus | null) => void;
}
export const useMotoDeportivaStore = create<MotoDeportivaState>((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
}));

/** Non-hook read for callbacks (estimates). False until the first successful poll. */
export function isMotoDeportivaRequestable(): boolean {
  return motoDeportivaCard(useMotoDeportivaStore.getState().status).requestable;
}

export function useMotoDeportivaStatus(enabled: boolean) {
  const status = useMotoDeportivaStore((s) => s.status);
  const setStatusInStore = useMotoDeportivaStore((s) => s.setStatus);
  const refetch = useCallback(async () => {
    if (!enabled) return;
    setStatusInStore(await motoDeportivaService.getStatus());
  }, [enabled, setStatusInStore]);
  useRefreshOnFocus(refetch);
  useEffect(() => {
    if (!enabled) return;
    void refetch();
    const id = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(id);
  }, [enabled, refetch]);
  const setWaitlist = useCallback(async (join: boolean) => {
    const waiting = await motoDeportivaService.setWaitlist(join);
    const cur = useMotoDeportivaStore.getState().status;
    if (cur) setStatusInStore({ ...cur, waiting });
  }, [setStatusInStore]);
  return { status, card: motoDeportivaCard(status), refetch, setWaitlist };
}
