'use client';

import { useState, useEffect, useCallback } from 'react';

interface GeolocationState {
  latitude: number | null;
  longitude: number | null;
  loading: boolean;
  error: string | null;
}

export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({
    latitude: null,
    longitude: null,
    loading: false,
    error: null,
  });

  // Watch position for real-time updates (blue dot on map)
  useEffect(() => {
    if (typeof window === 'undefined' || !navigator.geolocation) {
      return;
    }

    setState((s) => ({ ...s, loading: true }));

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setState({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          loading: false,
          error: null,
        });
      },
      (err) => {
        setState((s) => ({
          ...s,
          loading: false,
          error: err.code === 1 ? 'denied' : 'unavailable',
        }));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // One-shot request for the "Use my location" button
  const requestLocation = useCallback(
    (): Promise<{ latitude: number; longitude: number }> =>
      new Promise((resolve, reject) => {
        if (typeof window === 'undefined' || !navigator.geolocation) {
          reject(new Error('not_supported'));
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const coords = {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
            };
            setState({ ...coords, loading: false, error: null });
            resolve(coords);
          },
          (err) => {
            const errKey = err.code === 1 ? 'denied' : 'unavailable';
            setState((s) => ({ ...s, loading: false, error: errKey }));
            reject(new Error(errKey));
          },
          { enableHighAccuracy: true, timeout: 10000 },
        );
      }),
    [],
  );

  return { ...state, requestLocation };
}
