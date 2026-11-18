import { create } from 'zustand';
import type { DriverProfile } from '@tricigo/types';
import { shiftAfterServerRow } from '@/services/systemOfflineRecovery';

interface DriverState {
  profile: DriverProfile | null;
  /**
   * The app's shift. Follows the server, except that a row saying the SYSTEM took
   * the driver offline does not end it (see shiftAfterServerRow): the recovery
   * decides, and ends it with setOnline(false) when it cannot reconnect.
   */
  isOnline: boolean;
  /** True once the initial profile fetch has completed SUCCESSFULLY. */
  isProfileLoaded: boolean;
  /**
   * True when the last profile fetch FAILED (network/timeout/transient error)
   * rather than genuinely returning "no profile". Routing must not treat this
   * as "new user → onboarding"; the app keeps waiting/retrying instead.
   */
  profileLoadError: boolean;
  setProfile: (profile: DriverProfile | null) => void;
  setOnline: (isOnline: boolean) => void;
  setProfileLoaded: () => void;
  /** Mark that the profile fetch errored. Keeps any previously-loaded profile. */
  setProfileError: () => void;
  reset: () => void;
}

export const useDriverStore = create<DriverState>((set) => ({
  profile: null,
  isOnline: false,
  isProfileLoaded: false,
  profileLoadError: false,
  setProfile: (profile) =>
    set((state) => ({
      profile,
      isOnline: shiftAfterServerRow(state.isOnline, profile),
      isProfileLoaded: true,
      profileLoadError: false,
    })),
  setOnline: (isOnline) => set({ isOnline }),
  setProfileLoaded: () => set({ isProfileLoaded: true, profileLoadError: false }),
  setProfileError: () => set({ profileLoadError: true }),
  reset: () =>
    set({ profile: null, isOnline: false, isProfileLoaded: false, profileLoadError: false }),
}));
