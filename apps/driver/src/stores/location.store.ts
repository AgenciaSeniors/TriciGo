import { create } from 'zustand';

interface LocationState {
  latitude: number | null;
  longitude: number | null;
  heading: number | null;
  setLocation: (lat: number, lng: number, heading: number | null) => void;
}

export const useLocationStore = create<LocationState>((set) => ({
  latitude: null,
  longitude: null,
  heading: null,
  setLocation: (latitude, longitude, heading) => set({ latitude, longitude, heading }),
}));
