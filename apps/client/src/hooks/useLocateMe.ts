import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as Location from 'expo-location';
import { useTranslation } from '@tricigo/i18n';
import { getFreshPosition } from '@/lib/userLocation';

/**
 * "Center on my location" behavior behind a map FAB.
 *
 * Requests permission (explaining the denial rather than failing silently),
 * resolves a position, and hands it to `onFix` as [lng, lat] — Mapbox order,
 * ready for setCamera. Everything else is left to the caller: the picker
 * moves its pin, the vehicle-selection map just flies the camera.
 *
 * Failures are deliberately quiet past the permission prompt: the map keeps
 * showing wherever it already was, which is a usable state.
 */
export function useLocateMe(onFix: (lng: number, lat: number) => void) {
  const { t } = useTranslation('rider');
  const [isLocating, setIsLocating] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const locate = useCallback(async () => {
    if (isLocating) return;
    setIsLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(t('ride.location_off_title'), t('ride.location_off_body'));
        return;
      }
      const pos = await getFreshPosition();
      if (!pos || !mountedRef.current) return;
      onFix(pos.longitude, pos.latitude);
    } catch {
      /* silent — the map keeps its current position */
    } finally {
      if (mountedRef.current) setIsLocating(false);
    }
  }, [isLocating, onFix, t]);

  return { locate, isLocating };
}
