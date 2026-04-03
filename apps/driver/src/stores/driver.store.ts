import { create } from 'zustand';
import type { DriverProfile } from '@tricigo/types';

interface DriverState {
  profile: DriverProfile | null;
  isOnline: boolean;
  /** True once the initial profile fetch has completed (success or failure). */
  isProfileLoaded: boolean;
  setProfile: (profile: DriverProfile | null) => void;
  setOnline: (isOnline: boolean) => void;
  setProfileLoaded: () => void;
  reset: () => void;
}

export const useDriverStore = create<DriverState>((set) => ({
  profile: null,
  isOnline: false,
  isProfileLoaded: false,
  setProfile: (profile) =>
    set({ profile, isOnline: profile?.is_online ?? false, isProfileLoaded: true }),
  setOnline: (isOnline) => set({ isOnline }),
  setProfileLoaded: () => set({ isProfileLoaded: true }),
  reset: () =>
    set({ profile: null, isOnline: false, isProfileLoaded: false }),
}));
