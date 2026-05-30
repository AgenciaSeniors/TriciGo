import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTokens } from '@/hooks/useTokens';

export interface ProfileRowProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  /** Icon tint hex (6-digit). Used for the icon + its `${tint}1A` box. Defaults to brand orange. */
  tint?: string;
  subtitle?: string;
  /** Right slot (e.g. a Switch). Overrides the default value/chevron. */
  right?: React.ReactNode;
  /** Muted value text shown before the chevron (e.g. current language). */
  value?: string;
  onPress?: () => void;
  /** Drop the bottom hairline divider (last row in a card). */
  isLast?: boolean;
  /** Red icon-box + red label (e.g. delete account, logout). */
  destructive?: boolean;
  disabled?: boolean;
}

/**
 * Cuban Modern menu row: 36x36 tinted icon-box + label (+ optional subtitle)
 * + right slot (value/chevron or custom). Mirrors the driver profile rows.
 * Designed to live inside a `ProfileSection` card.
 */
export function ProfileRow({
  icon,
  label,
  tint,
  subtitle,
  right,
  value,
  onPress,
  isLast = false,
  destructive = false,
  disabled = false,
}: ProfileRowProps) {
  const tokens = useTokens();
  const effectiveTint = destructive ? '#EF4444' : (tint ?? tokens.accent.orange);
  const labelColor = destructive ? '#EF4444' : tokens.ink.primary;

  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 14,
        borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: tokens.line,
      }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 11,
          backgroundColor: `${effectiveTint}1A`,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 14,
        }}
      >
        <Ionicons name={icon} size={18} color={effectiveTint} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: labelColor, fontSize: 15, fontWeight: '500' }}>{label}</Text>
        {subtitle ? (
          <Text style={{ color: tokens.ink.secondary, fontSize: 12, marginTop: 2 }}>{subtitle}</Text>
        ) : null}
      </View>
      {right !== undefined ? (
        right
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {value ? (
            <Text style={{ color: tokens.ink.secondary, fontSize: 14, marginRight: 6 }}>{value}</Text>
          ) : null}
          {onPress ? <Ionicons name="chevron-forward" size={18} color={tokens.ink.subtle} /> : null}
        </View>
      )}
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        pressed && { opacity: 0.65, backgroundColor: tokens.bg.elev2 },
        disabled && { opacity: 0.5 },
      ]}
    >
      {body}
    </Pressable>
  );
}
