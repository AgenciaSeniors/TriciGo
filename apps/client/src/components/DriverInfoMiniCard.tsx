// ============================================================
// TriciGo — DriverInfoMiniCard
// Shows a compact card with drivers reviewing the ride request.
// Horizontal scroll of mini driver chips + count.
// ============================================================

import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, ScrollView, StyleSheet } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';
import { getInitials } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import type { SearchingDriverPresence } from '@tricigo/types';

interface DriverInfoMiniCardProps {
  drivers: SearchingDriverPresence[];
  isSearching: boolean;
}

/** Extract first name from full name */
function firstName(name: string): string {
  return name.split(' ')[0] ?? name;
}

/** Individual driver chip with slide-in animation */
function DriverChip({ driver, index }: { driver: SearchingDriverPresence; index: number }) {
  const slideAnim = useRef(new Animated.Value(30)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 250,
        delay: index * 80,
        useNativeDriver: true,
      }),
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 250,
        delay: index * 80,
        useNativeDriver: true,
      }),
    ]).start();
  }, [slideAnim, fadeAnim, index]);

  return (
    <Animated.View
      style={[
        styles.chip,
        {
          opacity: fadeAnim,
          transform: [{ translateX: slideAnim }],
        },
      ]}
    >
      {driver.avatarUrl ? (
        <Image source={{ uri: driver.avatarUrl }} style={styles.chipAvatar} />
      ) : (
        <View style={styles.chipInitials}>
          <Text style={styles.chipInitialsText}>{getInitials(driver.name)}</Text>
        </View>
      )}
      <Text style={styles.chipName} numberOfLines={1}>
        {firstName(driver.name)}
      </Text>
      <View style={styles.chipRating}>
        <Ionicons name="star" size={10} color={colors.warning.DEFAULT} />
        <Text style={styles.chipRatingText}>{driver.rating.toFixed(1)}</Text>
      </View>
    </Animated.View>
  );
}

export function DriverInfoMiniCard({ drivers, isSearching }: DriverInfoMiniCardProps) {
  const { t } = useTranslation('rider');
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  if (!isSearching) return null;

  const count = drivers.length;

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      {/* Header: driver count */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.pulsingDot} />
          <Text style={styles.countText}>
            {count === 0
              ? t('searching.no_drivers_yet')
              : count === 1
                ? t('searching.drivers_viewing', { count })
                : t('searching.drivers_viewing_plural', { count })}
          </Text>
        </View>
        {count > 0 && (
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{count}</Text>
          </View>
        )}
      </View>

      {/* Driver chips — horizontal scroll */}
      {count > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipScroll}
        >
          {drivers.map((driver, idx) => (
            <DriverChip key={driver.driverId} driver={driver} index={idx} />
          ))}
        </ScrollView>
      )}

      {/* Tip text */}
      {count > 0 && (
        <Text style={styles.tipText}>{t('searching.tip')}</Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(17, 17, 17, 0.95)',
    borderRadius: 16,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  pulsingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.brand.orange,
    marginRight: 8,
  },
  countText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  countBadge: {
    backgroundColor: colors.brand.orange,
    borderRadius: 10,
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  chipScroll: {
    paddingBottom: 8,
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 10,
    gap: 6,
  },
  chipAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  chipInitials: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.brand.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipInitialsText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  chipName: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
    maxWidth: 60,
  },
  chipRating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  chipRatingText: {
    color: colors.neutral[400],
    fontSize: 10,
    fontWeight: '600',
  },
  tipText: {
    color: colors.neutral[500],
    fontSize: 11,
    textAlign: 'center',
    marginTop: 4,
  },
});
