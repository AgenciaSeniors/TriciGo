import { Linking } from 'react-native';
import { supportPanelLink } from '@tricigo/utils/supportPanelLink';

/**
 * Staff support alerts ("Pasajero pide ayuda", "Viaje sin conductor") reach operators on this app.
 * Tapping one opens the ride's assist page in the browser, where the panel session lives, instead
 * of this app's home. Returns true when it handled the tap.
 */
export function openSupportPanelLink(data: unknown): boolean {
  const url = supportPanelLink(data);
  if (!url) return false;
  Linking.openURL(url).catch((err: unknown) => {
    console.warn('[supportPanel] could not open the assist page', err);
  });
  return true;
}
