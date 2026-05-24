// ============================================================
// TriciGo — SourceAttribution
//
// Tiny "Powered by Google" / "© Mapbox" label for the bottom of
// address search dropdowns. Required by both Google's TOS (must show
// "Powered by Google" prominently when displaying Places data) and
// Mapbox's TOS (must show "© Mapbox" attribution).
//
// Usage:
//   <SourceAttribution source="google" />
//   <SourceAttribution source="mapbox" />
//   <SourceAttribution source="mixed" /> // when results came from both
//
// Style: small, gray, italic — non-intrusive but legible.
// ============================================================

import React from 'react';
import { View, Text } from 'react-native';

export interface SourceAttributionProps {
  source: 'google' | 'mapbox' | 'mixed';
  /** When true, white text on dark background (driver app's dark theme). */
  isDark?: boolean;
  /** Optional className for layout overrides. */
  className?: string;
}

export function SourceAttribution({ source, isDark, className }: SourceAttributionProps) {
  const label =
    source === 'google' ? 'Powered by Google' :
    source === 'mapbox' ? '© Mapbox' :
    'Powered by Google + © Mapbox';

  const textColor = isDark ? 'text-neutral-400' : 'text-neutral-500';

  return (
    <View className={`px-3 py-1.5 ${className ?? ''}`}>
      <Text className={`text-[10px] italic ${textColor}`}>{label}</Text>
    </View>
  );
}

/**
 * Helper for callers to infer the right `source` prop from a results
 * array. Returns 'mixed' when the array has results from both providers,
 * otherwise the provider that contributed all results.
 */
export function inferAttributionSource(
  results: Array<{ source: string }>,
): 'google' | 'mapbox' | 'mixed' | null {
  if (!results || results.length === 0) return null;
  const hasGoogle = results.some((r) => r.source === 'google');
  const hasMapbox = results.some((r) =>
    r.source === 'mapbox' || r.source === 'searchbox'
  );
  if (hasGoogle && hasMapbox) return 'mixed';
  if (hasGoogle) return 'google';
  if (hasMapbox) return 'mapbox';
  return null; // results came from supabase/etc — no external attribution required
}
