import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const MAP_DETAIL_KEY = '@tricigo/map_detail';

/**
 * Whether to draw the heavier map layers (3D buildings).
 *
 * Off by default and opt-in, deliberately: there is no device-capability
 * detection in this codebase, so the alternative would be handing every
 * rider on modest hardware a slower map they never asked for. Mirrors the
 * driver app's `driver_simple_map_mode`, which likewise only suppresses
 * visual layers.
 *
 * State is shared across every caller through a module-level value and a
 * subscriber list. Three screens read this — Settings, vehicle selection
 * and the active ride — and the active ride stays mounted for the whole
 * trip. With per-hook state, flipping the switch mid-trip would leave that
 * map on the old value until the trip ended. This is the stale-on-mount
 * class CLAUDE.md keeps as a standing audit dimension.
 */

let currentValue = false;
let loaded = false;
const subscribers = new Set<(v: boolean) => void>();

function publish(v: boolean) {
  currentValue = v;
  for (const fn of subscribers) fn(v);
}

export function useMapDetail(): { mapDetail: boolean; setMapDetail: (v: boolean) => void } {
  const [mapDetail, setLocal] = useState(currentValue);

  useEffect(() => {
    subscribers.add(setLocal);
    // Read once per app run, no matter how many screens ask.
    if (!loaded) {
      loaded = true;
      void AsyncStorage.getItem(MAP_DETAIL_KEY)
        .then((v) => publish(v === '1'))
        .catch(() => {});
    } else {
      setLocal(currentValue);
    }
    return () => {
      subscribers.delete(setLocal);
    };
  }, []);

  const setMapDetail = useCallback((v: boolean) => {
    publish(v);
    AsyncStorage.setItem(MAP_DETAIL_KEY, v ? '1' : '0').catch(() => {});
  }, []);

  return { mapDetail, setMapDetail };
}
