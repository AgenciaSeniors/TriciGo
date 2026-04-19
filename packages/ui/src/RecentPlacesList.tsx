/**
 * RecentPlacesList — quick-access list of recent destinations.
 *
 * Shown directly on the home below the destination search bar, giving
 * repeat riders 1-tap access to their last 2-3 places.
 *
 * Reference: docs/DESIGN_CLIENT_HOME.md §4
 */
import React from 'react';
import { View, Text as RNText, StyleSheet, Pressable } from 'react-native';
import { cubanLight, cubanDark } from '@tricigo/theme';

export interface RecentPlace {
  id: string;
  name: string;
  /** e.g. "Hace 2h · Habana", "Ayer" */
  when: string;
}

export interface RecentPlacesListProps {
  places: RecentPlace[];
  onSelect: (place: RecentPlace) => void;
  mode?: 'light' | 'dark';
  emptyLabel?: string;
}

export function RecentPlacesList({
  places,
  onSelect,
  mode = 'light',
  emptyLabel,
}: RecentPlacesListProps) {
  const tokens = mode === 'dark' ? cubanDark : cubanLight;

  if (places.length === 0) {
    if (!emptyLabel) return null;
    return (
      <RNText style={[styles.empty, { color: tokens.ink.subtle }]}>
        {emptyLabel}
      </RNText>
    );
  }

  return (
    <View>
      {places.map((p, idx) => (
        <Pressable
          key={p.id}
          onPress={() => onSelect(p)}
          style={({ pressed }) => [
            styles.item,
            {
              borderBottomColor: tokens.line,
              borderBottomWidth: idx === places.length - 1 ? 0 : 1,
              opacity: pressed ? 0.6 : 1,
            },
          ]}
        >
          <View
            style={[
              styles.dot,
              { borderColor: tokens.accent.orange },
            ]}
          />
          <View style={styles.info}>
            <RNText
              style={[styles.name, { color: tokens.ink.primary }]}
              numberOfLines={1}
            >
              {p.name}
            </RNText>
            <RNText style={[styles.when, { color: tokens.ink.subtle }]}>
              {p.when}
            </RNText>
          </View>
          <RNText style={[styles.arrow, { color: tokens.ink.subtle }]}>›</RNText>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    paddingVertical: 16,
    textAlign: 'center',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontFamily: 'Montserrat_500Medium',
    fontSize: 14,
  },
  when: {
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 11,
    marginTop: 2,
  },
  arrow: {
    fontSize: 18,
    fontFamily: 'Inter_400Regular',
  },
});
