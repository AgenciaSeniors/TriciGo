import { useEffect } from 'react';
import * as Location from 'expo-location';
import { useTranslation } from 'react-i18next';
import { reverseGeocode } from '@tricigo/utils';
import { useRideStore } from '@/stores/ride.store';
import { startPickupFromGps, type LatLng } from '@/lib/pickupFromGps';

const toLatLng = (pos: Location.LocationObject): LatLng => ({
  latitude: pos.coords.latitude,
  longitude: pos.coords.longitude,
});

/**
 * Fills the service picker's pickup from the rider's position when the home
 * screen could not (see `startPickupFromGps`). Starts once per mount of the
 * picker: a pickup the rider clears afterwards is theirs to fill.
 */
export function usePickupFromGps(): void {
  const { t } = useTranslation('rider');

  useEffect(() => {
    // What the home screen shows while it looks the address up (same call).
    const detecting = t('home.detecting_address', { defaultValue: 'Detectando dirección...' });
    const pickup = () => useRideStore.getState().draft.pickup;

    return startPickupFromGps({
      pickupIsPending: () => {
        const current = pickup();
        return !current || current.address === detecting;
      },
      pendingLocation: () => {
        const current = pickup();
        return current && current.address === detecting ? current.location : null;
      },
      hasPermission: async () => (await Location.getForegroundPermissionsAsync()).status === 'granted',
      lastKnown: async () => {
        const pos = await Location.getLastKnownPositionAsync();
        return pos ? toLatLng(pos) : null;
      },
      watchFirstFix: (onFix) => {
        let subscription: Location.LocationSubscription | null = null;
        let stopped = false;
        Location.watchPositionAsync(
          // No "turn on location" dialog: the rider did not ask for this.
          { accuracy: Location.Accuracy.Balanced, mayShowUserSettingsDialog: false },
          (pos) => onFix(toLatLng(pos)),
        )
          .then((sub) => {
            if (stopped) sub.remove();
            else subscription = sub;
          })
          .catch(() => {
            // Location off: the rider types the pickup.
          });
        return () => {
          stopped = true;
          subscription?.remove();
        };
      },
      reverseGeocode: (loc) => reverseGeocode(loc.latitude, loc.longitude),
      fill: (address, loc) => {
        const store = useRideStore.getState();
        store.setPrefetchedPickup({ address, location: loc });
        store.setPickup(address, loc);
      },
      // setPickup would drop the fare estimate, and the picker only asks for a
      // new one when the coordinates change: the cards would sit without prices.
      setAddress: (address) => {
        const store = useRideStore.getState();
        const current = store.draft.pickup;
        if (!current) return;
        store.setPrefetchedPickup({ address, location: current.location });
        store.setEndpointAddress('pickup', address);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  }, [t]);
}
