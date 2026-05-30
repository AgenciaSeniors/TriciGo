import React from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTokens } from '@/hooks/useTokens';
import { useThemeStore } from '@/stores/theme.store';

export interface ProfileSectionProps {
  /** Uppercase group label shown above the card. Omit for an unlabeled card. */
  title?: string;
  children: React.ReactNode;
  /** Bottom margin between groups (default 20). */
  marginBottom?: number;
}

/**
 * Cuban Modern menu group: uppercase label + elevated card container that
 * wraps a set of `ProfileRow`s. Mirrors the driver profile's menu sections.
 */
export function ProfileSection({ title, children, marginBottom = 20 }: ProfileSectionProps) {
  const tokens = useTokens();
  const isDark = useThemeStore((s) => s.resolvedScheme) === 'dark';
  const cardShadow = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.4 : 0.06,
    shadowRadius: 8,
    elevation: 2,
  };

  return (
    <View style={{ marginBottom }}>
      {title ? (
        <Text
          style={{
            color: tokens.ink.secondary,
            fontSize: 11,
            fontWeight: '700',
            textTransform: 'uppercase',
            letterSpacing: 1.2,
            marginBottom: 8,
            marginLeft: 4,
          }}
        >
          {title}
        </Text>
      ) : null}
      <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, overflow: 'hidden', ...cardShadow }}>
        {children}
      </View>
    </View>
  );
}
