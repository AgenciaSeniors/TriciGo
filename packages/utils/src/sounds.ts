/**
 * Sound feedback utilities for ride events.
 * Uses indirect require to prevent webpack (Next.js) from bundling expo-av.
 * In Expo apps, plays short notification sounds.
 * In Next.js/web, silently no-ops.
 */

import { triggerHaptic } from './haptics';

// Indirect require prevents webpack static analysis
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const _require = typeof require !== 'undefined' ? require : undefined;
const AV_MODULE = 'expo-' + 'av';

function getAudio(): any {
  try {
    const mod = _require?.(AV_MODULE);
    return mod?.Audio ?? null;
  } catch {
    return null;
  }
}

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

// Cache loaded Audio.Sound instances
const soundCache = new Map<SoundEvent, any>();
let audioConfigured = false;

/**
 * Play a short notification sound for a ride event.
 * Silently no-ops if expo-av is not available or no asset is registered.
 */
export async function playSound(event: SoundEvent): Promise<void> {
  const Audio = getAudio();
  if (!Audio) return;

  const asset = soundAssets[event];
  if (!asset) return;

  try {
    // Configure audio mode once (respect silent switch on iOS)
    if (!audioConfigured) {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: false,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });
      audioConfigured = true;
    }

    // Unload previous instance if exists
    const cached = soundCache.get(event);
    if (cached) {
      try {
        await cached.unloadAsync();
      } catch {
        // Ignore unload errors
      }
      soundCache.delete(event);
    }

    // Create and play
    const { sound } = await Audio.Sound.createAsync(asset, {
      shouldPlay: true,
      volume: 0.8,
    });
    soundCache.set(event, sound);

    // Auto-unload after playback finishes
    sound.setOnPlaybackStatusUpdate((status: any) => {
      if (status.didJustFinish) {
        sound.unloadAsync().catch(() => {});
        soundCache.delete(event);
      }
    });
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
