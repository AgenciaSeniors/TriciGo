import { create } from 'zustand';
import type { DriverProfile } from '@tricigo/types';

interface DriverState {
  profile: DriverProfile | null;
  isOnline: boolean;
  setProfile: (profile: DriverProfile | null) => void;
  setOnline: (isOnline: boolean) => void;
  reset: () => void;
}

export const useDriverStore = create<DriverState>((set) => ({
  profile: null,
  isOnline: false,
  setProfile: (profile) =>
    set({ profile, isOnline: profile?.is_online ?? false }),
  setOnline: (isOnline) => set({ isOnline }),
  reset: () =>
    set({ profile: null, isOnline: false }),
}));
