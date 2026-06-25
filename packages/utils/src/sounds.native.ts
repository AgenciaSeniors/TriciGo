/**
 * Sound feedback utilities — native implementation.
 * Metro resolves this file on iOS/Android; webpack ignores `.native.ts`.
 * Static import ensures expo-audio is registered as a bundle dependency.
 *
 * Migrated from expo-av (deprecated, no SDK 55 / new-arch build) to
 * expo-audio, the official replacement. Same public API (registerSoundAssets
 * / playSound / triggerFeedback) — only the native player implementation changed.
 */

import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { triggerHaptic } from './haptics';

export type SoundEvent =
  | 'ride_accepted'
  | 'driver_arrived'
  | 'trip_completed'
  | 'new_request'
  | 'destination_arrived';

/** Map sound events to the asset require() call.
 *  Each app must register its own sound map via `registerSoundAssets()`. */
let soundAssets: Partial<Record<SoundEvent, any>> = {};

/**
 * Register sound file assets from the app.
 * Must be called from the app entry (e.g. _layout.tsx) because require()
 * paths must resolve relative to the app, not the utils package.
 *
 * @example
 * registerSoundAssets({
 *   ride_accepted: require('../assets/sounds/ride_accepted.mp3'),
 *   new_request: require('../assets/sounds/new_request.mp3'),
 * });
 */
export function registerSoundAssets(
  assets: Partial<Record<SoundEvent, any>>,
): void {
  soundAssets = { ...soundAssets, ...assets };
}

// Cache loaded AudioPlayer instances
const soundCache = new Map<SoundEvent, AudioPlayer>();
let audioConfigured = false;

/**
 * Play a short notification sound for a ride event.
 * Silently no-ops if no asset is registered.
 */
export async function playSound(event: SoundEvent): Promise<void> {
  const asset = soundAssets[event];
  if (!asset) return;

  try {
    // Configure audio mode once (respect silent switch on iOS, duck others)
    if (!audioConfigured) {
      await setAudioModeAsync({
        playsInSilentMode: false,
        shouldPlayInBackground: false,
        interruptionMode: 'duckOthers',
      });
      audioConfigured = true;
    }

    // Release previous instance if exists
    const cached = soundCache.get(event);
    if (cached) {
      try {
        cached.remove();
      } catch {
        // Ignore release errors
      }
      soundCache.delete(event);
    }

    // Create and play
    const player = createAudioPlayer(asset);
    player.volume = 0.8;
    soundCache.set(event, player);

    // Auto-release after playback finishes
    player.addListener('playbackStatusUpdate', (status) => {
      if (status.didJustFinish) {
        try {
          player.remove();
        } catch {
          // Ignore release errors
        }
        soundCache.delete(event);
      }
    });

    player.play();
  } catch {
    // Sound playback failed (e.g. no permissions, no audio device)
  }
}

/**
 * Trigger combined sound + haptic feedback for ride events.
 * Runs both in parallel for instantaneous feedback.
 */
export async function triggerFeedback(
  event: SoundEvent,
  hapticType: 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' = 'medium',
): Promise<void> {
  await Promise.all([
    playSound(event),
    triggerHaptic(hapticType),
  ]);
}
