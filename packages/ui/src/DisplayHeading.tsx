/**
 * DisplayHeading — serif italic emotional heading.
 *
 * Used for the main "¿A dónde vamos hoy?" question on the redesigned
 * client home. Uses Instrument Serif italic for soul + an underline
 * gradient accent for visual anchor.
 *
 * Reference: docs/DESIGN_CLIENT_HOME.md §4
 */
import React from 'react';
import { View, Text as RNText, StyleSheet } from 'react-native';
import { cubanLight, cubanDark } from '@tricigo/theme';

export interface DisplayHeadingProps {
  children: React.ReactNode;
  mode?: 'light' | 'dark';
  /** If true, show the gradient underline accent below the heading. */
  underline?: boolean;
  /** Override the font size (default 30) */
  size?: number;
}

export function DisplayHeading({
  children,
  mode = 'light',
  underline = true,
  size = 30,
}: DisplayHeadingProps) {
  const tokens = mode === 'dark' ? cubanDark : cubanLight;

  return (
    <View>
      <RNText
        style={[
          styles.heading,
          { color: tokens.ink.primary, fontSize: size },
        ]}
      >
        {children}
      </RNText>
      {underline && (
        <View style={styles.underlineWrap}>
          <View
            style={[
              styles.underlineBase,
              { backgroundColor: tokens.accent.orange },
            ]}
          />
          <View
            style={[
              styles.underlineGradient,
              { backgroundColor: tokens.accent.warm },
            ]}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontFamily: 'InstrumentSerif_400Regular_Italic',
    lineHeight: 36,
    letterSpacing: -0.5,
  },
  underlineWrap: {
    marginTop: 8,
    height: 3,
    width: 64,
    borderRadius: 2,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  underlineBase: {
    flex: 1,
  },
  underlineGradient: {
    flex: 1,
  },
});
