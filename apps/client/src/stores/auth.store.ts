import { create } from 'zustand';
import type { User } from '@tricigo/types';

interface AuthState {
  user: User | null;
  /**
   * `app_metadata.provider` of the live session ('apple' | 'google' | 'phone'
   * | 'email' | null). Kept next to the profile row because the row itself
   * cannot tell us HOW the account was created, and the onboarding guard needs
   * that: a social sign-in must never be forced through a "type your name"
   * screen (Apple Guideline 4), while a phone/OTP sign-up still must be — no
   * provider hands us a name there.
   */
  authProvider: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isInitialized: boolean;
  setUser: (user: User | null) => void;
  setAuthProvider: (provider: string | null) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  authProvider: null,
  isAuthenticated: false,
  isLoading: true,
  isInitialized: false,
  setUser: (user) =>
    set((state) => ({
      // A blank full_name arriving for the user we already hold is always a
      // stale read, never a real change: nothing in the product clears a name.
      // It happens because the SIGNED_IN listener's profile fetch races the
      // write that stores the name Apple returned at sign-in. Keeping the name
      // we already have costs nothing and stops the race from blanking the
      // pre-filled field on the phone screen.
      user:
        user && state.user && user.id === state.user.id && !user.full_name && state.user.full_name
          ? { ...user, full_name: state.user.full_name }
          : user,
      isAuthenticated: !!user,
      isLoading: false,
      isInitialized: true,
    })),
  setAuthProvider: (authProvider) => set({ authProvider }),
  setLoading: (isLoading) => set({ isLoading }),
  reset: () =>
    set({
      user: null,
      authProvider: null,
      isAuthenticated: false,
      isLoading: false,
      isInitialized: true,
    }),
}));
