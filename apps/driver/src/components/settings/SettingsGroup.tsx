/**
 * SettingsGroup — section header wrapper used to bucket settings into
 * the four semantic groups defined for PR-B2:
 *
 *   - Pantalla       (display, language, night mode)
 *   - Audio          (sounds, notifications)
 *   - Trabajo        (preferred zone, silent mode, auto-accept, SMS)
 *   - Cuenta         (account deletion / danger zone)
 *
 * Renders an uppercase tracked label on top, then yields its children
 * (typically one or more `<Card>`s holding `<SettingsRow>`s).
 *
 * The group header uses `midnightEmber.screen.text.secondary` so it
 * reads as supportive context rather than a dominant heading.
 */
import React from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { midnightEmber } from '@tricigo/theme';

export interface SettingsGroupProps {
  title: string;
  children: React.ReactNode;
  /** Vertical spacing under the group. Defaults to 24px. */
  marginBottom?: number;
}

export function SettingsGroup({
  title,
  children,
  marginBottom = 24,
}: SettingsGroupProps) {
  return (
    <View style={{ marginBottom }}>
      <Text
        variant="caption"
        style={{
          color: midnightEmber.screen.text.secondary,
          textTransform: 'uppercase',
          letterSpacing: 1.2,
          marginLeft: 4,
          marginBottom: 8,
          fontWeight: '600',
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
