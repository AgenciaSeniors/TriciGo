/**
 * Sound feedback utilities — default (web/SSR) implementation.
 * No-ops because expo-av only runs on native devices.
 *
 * Metro automatically resolves `sounds.native.ts` instead of this file
 * on iOS/Android. Webpack (Next.js) uses this file and never touches
 * `.native.ts` — so expo-av is never bundled on web.
 */

import { triggerHaptic } from './haptics';

export type SoundEvent =
  | 'ride_accepted'
  | 'driver_arrived'
  | 'trip_completed'
  | 'new_request'
  | 'destination_arrived';

export function registerSoundAssets(
  _assets: Partial<Record<SoundEvent, any>>,
): void {
  // No-op on web
}

export async function playSound(_event: SoundEvent): Promise<void> {
  // No-op on web
}

export async function triggerFeedback(
  event: SoundEvent,
  hapticType: 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' = 'medium',
): Promise<void> {
  await Promise.all([
    playSound(event),
    triggerHaptic(hapticType),
  ]);
}
