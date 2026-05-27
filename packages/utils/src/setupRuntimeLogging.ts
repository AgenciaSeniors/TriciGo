/**
 * Runtime logging setup — web stub.
 *
 * The native implementation (`setupRuntimeLogging.native.ts`) silences
 * Expo SDK + NativeWind warnings via LogBox and HermesInternal's promise
 * rejection tracker. None of those apply on web, so this is a no-op.
 *
 * Metro/Expo resolves this file on web; the .native.ts variant is picked
 * up on iOS/Android via the React Native bundler platform extension.
 */
export function setupRuntimeLogging(): void {
  // no-op on web
}
