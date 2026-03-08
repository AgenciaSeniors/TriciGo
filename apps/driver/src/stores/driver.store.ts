import { create } from 'zustand';
import type { DriverProfile, Ride } from '@tricigo/types';

interface DriverState {
  profile: DriverProfile | null;
  isOnline: boolean;
  activeTrip: Ride | null;
  setProfile: (profile: DriverProfile | null) => void;
  setOnline: (isOnline: boolean) => void;
  setActiveTrip: (trip: Ride | null) => void;
  reset: () => void;
}

export const useDriverStore = create<DriverState>((set) => ({
  profile: null,
  isOnline: false,
  activeTrip: null,
  setProfile: (profile) =>
    set({ profile, isOnline: profile?.is_online ?? false }),
  setOnline: (isOnline) => set({ isOnline }),
  setActiveTrip: (activeTrip) => set({ activeTrip }),
  reset: () =>
    set({ profile: null, isOnline: false, activeTrip: null }),
}));
