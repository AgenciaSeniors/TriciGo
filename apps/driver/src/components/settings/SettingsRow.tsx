/**
 * SettingsRow — extracted from `apps/driver/app/profile/settings.tsx`
 * for PR-B2.
 *
 * Standardizes the icon + title + (optional subtitle) + right-slot row
 * pattern that was duplicated 8+ times across the settings screen.
 *
 * Uses `midnightEmber.screen.*` tokens from PR-B1 — surface for the
 * 36×36 icon container, primary/secondary text, and the
 * `accent[500]` for the icon glyph.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { midnightEmber } from '@tricigo/theme';

export interface SettingsRowProps {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  /** Secondary line shown under the title in `screen.text.secondary`. */
  subtitle?: string;
  /** Right-side slot — typically a `<Switch>` or a text value. */
  right?: React.ReactNode;
  /**
   * If provided, the whole row becomes pressable. Mutually exclusive
   * with a `<Switch>` in `right` — the switch already handles its own
   * press.
   */
  onPress?: () => void;
  accessibilityLabel?: string;
  /**
   * Render a hairline border above this row. Use when stacking
   * multiple rows in the same `<Card>` so they read as a list.
   */
  withTopBorder?: boolean;
}

export function SettingsRow({
  icon,
  title,
  subtitle,
  right,
  onPress,
  accessibilityLabel,
  withTopBorder,
}: SettingsRowProps) {
  const Body = (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 48,
        },
        withTopBorder && {
          marginTop: 8,
          paddingTop: 12,
          borderTopWidth: 1,
          borderTopColor: midnightEmber.screen.line.default,
        },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 12 }}>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: midnightEmber.radius.input,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 12,
            backgroundColor: midnightEmber.screen.bg.sunken,
          }}
        >
          <Ionicons name={icon} size={18} color={midnightEmber.accent[500]} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="body" color="primary">
            {title}
          </Text>
          {subtitle && (
            <Text
              variant="caption"
              color="secondary"
              style={{ marginTop: 2 }}
            >
              {subtitle}
            </Text>
          )}
        </View>
      </View>
      {right && <View>{right}</View>}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        // V3 — press feedback within ~100ms (HIG/MD). Mirrors the pattern
        // already in `@tricigo/ui/MenuRow`. Without this, every settings
        // row that uses `onPress` (~8 call sites today) read as static
        // text on tap. android_ripple gives a native feel on Android;
        // iOS uses the opacity transition.
        style={({ pressed }) => ({
          opacity: pressed ? 0.7 : 1,
        })}
        android_ripple={{ color: 'rgba(255, 77, 0, 0.08)' }}
      >
        {Body}
      </Pressable>
    );
  }

  return Body;
}
