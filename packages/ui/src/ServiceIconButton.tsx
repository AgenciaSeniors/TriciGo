/**
 * ServiceIconButton — vehicle/service selection card.
 *
 * Replaces the old ServiceTypeCard with a cleaner layout: 3D render
 * of the vehicle + name only (no price). Used in the 5-column home
 * services grid.
 *
 * Reference: docs/DESIGN_CLIENT_HOME.md §4
 */
import React from 'react';
import { View, Text as RNText, Image, StyleSheet, Pressable, Platform } from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { cubanLight, cubanDark } from '@tricigo/theme';

export interface ServiceIconButtonProps {
  icon: ImageSourcePropType;
  name: string;
  onPress?: () => void;
  /** Highlight this card (selected state) */
  active?: boolean;
  mode?: 'light' | 'dark';
  /** Set true if the row layout has 5 columns on a narrow phone — tightens padding */
  dense?: boolean;
}

export function ServiceIconButton({
  icon,
  name,
  onPress,
  active = false,
  mode = 'light',
  dense = false,
}: ServiceIconButtonProps) {
  const tokens = mode === 'dark' ? cubanDark : cubanLight;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        dense && styles.cardDense,
        {
          backgroundColor: tokens.bg.elev1,
          borderColor: active ? tokens.accent.orange : tokens.line,
          borderWidth: active ? 2 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
        },
      ]}
    >
      <View style={[styles.iconWrap, dense && styles.iconWrapDense]}>
        <Image source={icon} style={styles.icon} resizeMode="contain" />
      </View>
      <RNText
        style={[
          styles.name,
          dense && styles.nameDense,
          { color: tokens.ink.primary },
        ]}
        numberOfLines={1}
      >
        {name}
      </RNText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 20,
    paddingVertical: 14,
    paddingHorizontal: 6,
    alignItems: 'center',
    ...Platform.select({
      web: { boxShadow: '0 2px 20px rgba(30,20,10,0.04), 0 1px 2px rgba(30,20,10,0.06)' } as object,
      default: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.04,
        shadowRadius: 6,
      },
    }),
  },
  cardDense: {
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 4,
  },
  iconWrap: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  iconWrapDense: {
    width: 54,
    height: 54,
    marginBottom: 6,
  },
  icon: {
    width: '100%',
    height: '100%',
  },
  name: {
    fontFamily: 'BricolageGrotesque_600SemiBold',
    fontSize: 13,
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  nameDense: {
    fontSize: 12,
  },
});
