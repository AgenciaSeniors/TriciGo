import { create } from 'zustand';
import type { User } from '@tricigo/types';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isInitialized: boolean;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  isInitialized: false,
  setUser: (user) =>
    set({ user, isAuthenticated: !!user, isLoading: false, isInitialized: true }),
  setLoading: (isLoading) => set({ isLoading }),
  reset: () =>
    set({ user: null, isAuthenticated: false, isLoading: false, isInitialized: true }),
}));
