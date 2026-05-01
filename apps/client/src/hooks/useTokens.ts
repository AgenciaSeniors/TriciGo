// ============================================================
// useTokens — resolve Cuban Modern palette per active theme
// ============================================================

import { useThemeStore } from '@/stores/theme.store';
import { cubanLight, cubanDark } from '@tricigo/theme';

/**
 * Returns the resolved Cuban Modern palette based on the user's
 * current theme mode (light/dark, system-resolved). Prefer this
 * for StyleSheet-based components where Tailwind `dark:` variants
 * don't apply.
 *
 * For NativeWind components, prefer the `dark:` class variants
 * directly (e.g. `bg-cuban-paper dark:bg-cuban-dark-paper`).
 *
 * Returns the same structural shape regardless of mode, so consumers
 * can destructure without conditional logic:
 *
 *   const { bg, ink, accent, line } = useTokens();
 *   <View style={{ backgroundColor: bg.paper }}>
 *     <Text style={{ color: ink.primary }}>...</Text>
 *   </View>
 *
 * Return type is a union of the two literal-typed palettes so callers
 * see all property paths without explicit casts.
 */
export function useTokens() {
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  return resolvedScheme === 'dark' ? cubanDark : cubanLight;
}

export type Tokens = ReturnType<typeof useTokens>;
