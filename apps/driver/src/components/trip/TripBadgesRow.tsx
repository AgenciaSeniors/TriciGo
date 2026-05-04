/**
 * TripBadgesRow — Midnight Ember edition (PR-B).
 *
 * Renders cargo and corporate ride badges. Both can be visible at the
 * same time (corporate cargo trip).
 *
 * v2 tokenization:
 *   - Both badges now use a uniform pill style: `accent` family for
 *     cargo (the brand-tied operation), `info` family for corporate.
 *   - Replaces the previous mismatched solid `#FF4D00` + `bg-blue-600/80`.
 *   - Centered row with consistent spacing for readability.
 */
import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';

interface TripBadgesRowProps {
  isCargo: boolean;
  isCorporate: boolean;
}

interface BadgeProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  bgColor: string;
  fgColor: string;
}

function Badge({ icon, label, bgColor, fgColor }: BadgeProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: midnightEmber.radius.pill,
        backgroundColor: bgColor,
      }}
    >
      <Ionicons name={icon} size={14} color={fgColor} />
      <Text
        variant="caption"
        style={{ color: fgColor, fontWeight: '700' }}
      >
        {label}
      </Text>
    </View>
  );
}

export function TripBadgesRow({ isCargo, isCorporate }: TripBadgesRowProps) {
  const { t } = useTranslation('driver');

  if (!isCargo && !isCorporate) return null;

  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 8,
        marginBottom: 12,
      }}
    >
      {isCargo && (
        <Badge
          icon="cube"
          label="CARGO"
          bgColor={midnightEmber.accent[500]}
          fgColor={midnightEmber.map.text.onAccent}
        />
      )}
      {isCorporate && (
        <Badge
          icon="business"
          label={t('home.corporate_ride')}
          bgColor={midnightEmber.state.info}
          fgColor={midnightEmber.map.text.onAccent}
        />
      )}
    </View>
  );
}
