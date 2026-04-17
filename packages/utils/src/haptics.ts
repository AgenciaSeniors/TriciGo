/**
 * Haptic feedback utilities — default (web/SSR) implementation.
 * No-ops because expo-haptics only runs on native devices.
 *
 * Metro automatically resolves `haptics.native.ts` instead of this file
 * on iOS/Android. Webpack (Next.js) uses this file and never touches
 * `.native.ts` — so expo-haptics is never bundled on web.
 */

export async function triggerHaptic(
  _type: 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' = 'medium',
): Promise<void> {
  // No-op on web
}

export async function triggerSelection(): Promise<void> {
  // No-op on web
}
