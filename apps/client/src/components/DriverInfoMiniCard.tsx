// ============================================================
// TriciGo — DriverInfoMiniCard (BUG-293 redesign)
//
// Round 3 QA reported this card "feo" — a small chip with a 24×24
// avatar floating in a mostly-empty white box. This redesign turns it
// into the searching-state hero: pulsing search header, prominent
// driver row (or aggregated count for multi-driver), and the trip
// summary (pickup / dropoff / fare estimate) so the rider isn't
// staring at empty whitespace while they wait.
//
// Backward compat: all existing props remain. New trip-summary props
// are optional — caller can opt in. The container styling now uses
// the Cuban Modern surface tokens so it sits coherently above the map.
// ============================================================

import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, ScrollView, StyleSheet, useColorScheme } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';
import { getInitials } from '@tricigo/utils';
import { colors, darkColors } from '@tricigo/theme';
import type { SearchingDriverPresence } from '@tricigo/types';

interface DriverInfoMiniCardProps {
  drivers: SearchingDriverPresence[];
  isSearching: boolean;
  /** BUG-293: optional trip-summary block under the driver section. */
  pickupAddress?: string | null;
  dropoffAddress?: string | null;
  /** Pre-formatted fare label (e.g. "$1,440 CUP" or "$1,440 TRC"). */
  fareDisplay?: string | null;
  /** Pre-formatted ETA string (e.g. "~5 min"). */
  etaLabel?: string | null;
  /** Service type human label (e.g. "Triciclo Básico"). */
  serviceTypeLabel?: string | null;
}

function firstName(name: string): string {
  return name.split(' ')[0] ?? name;
}

/** Animated pulsing dot — 3 concentric rings expanding + fading in loop */
function PulsingRadarDot({ color }: { color: string }) {
  const rings = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];

  useEffect(() => {
    rings.forEach((ring, i) => {
      const delay = i * 600;
      const animate = () => {
        ring.setValue(0);
        Animated.timing(ring, {
          toValue: 1,
          duration: 2000,
          delay,
          useNativeDriver: true,
        }).start(({ finished }) => { if (finished) animate(); });
      };
      animate();
    });
    return () => rings.forEach((r) => r.stopAnimation());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
      {rings.map((ring, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            width: 10,
            height: 10,
            borderRadius: 5,
            borderWidth: 1.5,
            borderColor: color,
            opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
            transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 3] }) }],
          }}
        />
      ))}
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
    </View>
  );
}

/** Compact horizontal chip — used when multiple drivers are reviewing.
 *  Stays close in spirit to the previous chip but slightly larger so it
 *  doesn't disappear into the card. */
function DriverChip({ driver, index, isDark }: { driver: SearchingDriverPresence; index: number; isDark: boolean }) {
  const slideAnim = useRef(new Animated.Value(20)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: 0, duration: 220, delay: index * 70, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 220, delay: index * 70, useNativeDriver: true }),
    ]).start();
  }, [slideAnim, fadeAnim, index]);

  const chipBg = isDark ? darkColors.background.tertiary : colors.neutral[50];
  const chipBorder = isDark ? darkColors.border.light : colors.neutral[200];
  const chipText = isDark ? darkColors.text.primary : colors.neutral[900];
  const chipMuted = isDark ? darkColors.text.tertiary : colors.neutral[500];

  return (
    <Animated.View
      style={[
        styles.chip,
        { backgroundColor: chipBg, borderColor: chipBorder, opacity: fadeAnim, transform: [{ translateX: slideAnim }] },
      ]}
    >
      {driver.avatarUrl ? (
        <Image source={{ uri: driver.avatarUrl }} style={styles.chipAvatar} />
      ) : (
        <View style={styles.chipInitials}>
          <Text style={styles.chipInitialsText}>{getInitials(driver.name)}</Text>
        </View>
      )}
      <Text style={[styles.chipName, { color: chipText }]} numberOfLines={1}>
        {firstName(driver.name)}
      </Text>
      <View style={styles.chipRating}>
        <Ionicons name="star" size={11} color={colors.warning.DEFAULT} />
        <Text style={[styles.chipRatingText, { color: chipMuted }]}>{driver.rating.toFixed(1)}</Text>
      </View>
    </Animated.View>
  );
}

/** Prominent single-driver hero row — used when exactly 1 driver is
 *  reviewing the request. Replaces the tiny chip with a 56-px avatar
 *  and a one-line summary so the rider sees who's looking at the trip. */
function DriverHeroRow({ driver, isDark, serviceTypeLabel }: { driver: SearchingDriverPresence; isDark: boolean; serviceTypeLabel?: string | null }) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 260, useNativeDriver: true }).start();
  }, [fadeAnim]);

  const text = isDark ? darkColors.text.primary : colors.neutral[900];
  const mute = isDark ? darkColors.text.secondary : colors.neutral[500];

  return (
    <Animated.View style={[styles.heroRow, { opacity: fadeAnim }]}>
      {driver.avatarUrl ? (
        <Image source={{ uri: driver.avatarUrl }} style={styles.heroAvatar} />
      ) : (
        <View style={styles.heroInitials}>
          <Text style={styles.heroInitialsText}>{getInitials(driver.name)}</Text>
        </View>
      )}
      <View style={{ flex: 1, marginLeft: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[styles.heroName, { color: text }]} numberOfLines={1}>
            {driver.name}
          </Text>
          <View style={styles.heroRatingPill}>
            <Ionicons name="star" size={11} color={colors.warning.DEFAULT} />
            <Text style={styles.heroRatingText}>{driver.rating.toFixed(1)}</Text>
          </View>
        </View>
        {serviceTypeLabel ? (
          <Text style={[styles.heroService, { color: mute }]} numberOfLines={1}>
            {serviceTypeLabel}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

/** Pickup / dropoff / fare / ETA summary block. */
function TripSummary({
  pickupAddress,
  dropoffAddress,
  fareDisplay,
  etaLabel,
  isDark,
  t,
}: {
  pickupAddress?: string | null;
  dropoffAddress?: string | null;
  fareDisplay?: string | null;
  etaLabel?: string | null;
  isDark: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  if (!pickupAddress && !dropoffAddress && !fareDisplay && !etaLabel) return null;
  const text = isDark ? darkColors.text.primary : colors.neutral[900];
  const mute = isDark ? darkColors.text.tertiary : colors.neutral[500];
  const divider = isDark ? darkColors.border.light : colors.neutral[200];

  return (
    <View style={[styles.summary, { borderTopColor: divider }]}>
      {pickupAddress ? (
        <View style={styles.summaryRow}>
          <View style={[styles.summaryDot, { backgroundColor: '#22c55e' }]} />
          <Text style={[styles.summaryRowText, { color: text }]} numberOfLines={1}>
            {pickupAddress}
          </Text>
        </View>
      ) : null}
      {dropoffAddress ? (
        <View style={styles.summaryRow}>
          <View style={[styles.summaryDot, { backgroundColor: colors.brand.orange }]} />
          <Text style={[styles.summaryRowText, { color: text }]} numberOfLines={1}>
            {dropoffAddress}
          </Text>
        </View>
      ) : null}
      {(fareDisplay || etaLabel) ? (
        <View style={[styles.summaryFooter, { borderTopColor: divider }]}>
          {fareDisplay ? (
            <View style={{ flex: 1 }}>
              <Text style={[styles.summaryFooterLabel, { color: mute }]}>
                {t('ride.estimated_fare', { defaultValue: 'Tarifa estimada' })}
              </Text>
              <Text style={[styles.summaryFooterValue, { color: text }]}>{fareDisplay}</Text>
            </View>
          ) : null}
          {etaLabel ? (
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[styles.summaryFooterLabel, { color: mute }]}>
                {t('ride.eta', { defaultValue: 'Llegada' })}
              </Text>
              <Text style={[styles.summaryFooterValue, { color: text }]}>{etaLabel}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function DriverInfoMiniCard({
  drivers,
  isSearching,
  pickupAddress,
  dropoffAddress,
  fareDisplay,
  etaLabel,
  serviceTypeLabel,
}: DriverInfoMiniCardProps) {
  const { t } = useTranslation('rider');
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
  }, [fadeAnim]);

  if (!isSearching) return null;

  const count = drivers.length;
  const hasTripSummary = !!(pickupAddress || dropoffAddress || fareDisplay || etaLabel);

  // Even with 0 drivers we now show the trip summary while the radar
  // animation runs — that's exactly the "feo" empty card the user
  // complained about. With trip summary present the card carries useful
  // information from the first second of the search.
  if (count === 0 && !hasTripSummary) return null;

  const containerBg = isDark ? darkColors.background.secondary : '#fff';
  const containerBorder = isDark ? darkColors.border.light : colors.neutral[200];
  const headerText = isDark ? darkColors.text.primary : colors.neutral[900];

  const headerCopy =
    count === 0
      ? t('searching.looking_for_driver', { defaultValue: 'Buscando conductor cercano…' })
      : count === 1
        ? t('searching.drivers_viewing', { count, defaultValue: '1 conductor evaluando tu viaje' })
        : t('searching.drivers_viewing_plural', { count, defaultValue: `${count} conductores evaluando tu viaje` });

  return (
    <Animated.View
      style={[
        styles.container,
        { backgroundColor: containerBg, borderColor: containerBorder, opacity: fadeAnim },
      ]}
    >
      {/* Header — pulsing search dot + dynamic count copy + badge */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <PulsingRadarDot color={colors.brand.orange} />
          <Text style={[styles.countText, { color: headerText }]} numberOfLines={2}>
            {headerCopy}
          </Text>
        </View>
        {count > 0 ? (
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{count}</Text>
          </View>
        ) : null}
      </View>

      {/* Driver section */}
      {count === 1 ? (
        <DriverHeroRow driver={drivers[0]!} isDark={isDark} serviceTypeLabel={serviceTypeLabel} />
      ) : count > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipScroll}
        >
          {drivers.map((driver, idx) => (
            <DriverChip key={driver.driverId} driver={driver} index={idx} isDark={isDark} />
          ))}
        </ScrollView>
      ) : null}

      {/* Trip details summary */}
      <TripSummary
        pickupAddress={pickupAddress}
        dropoffAddress={dropoffAddress}
        fareDisplay={fareDisplay}
        etaLabel={etaLabel}
        isDark={isDark}
        t={t}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    // alignSelf:'stretch' overrides the searching-view parent's
    // `items-center` so the card spans the full width of its parent
    // (minus the 16px horizontal margins). Without it the card sized
    // to its narrowest child (~250px) and the addresses + driver hero
    // row got truncated/cramped on iPhone.
    alignSelf: 'stretch',
    // overflow:'hidden' clips the TripSummary footer to the rounded
    // card border. Was bleeding past the visible bottom and landing
    // visually at the same Y as the Cancel button below — caused the
    // "Tiempo estimado / ~16 min" + "Cancelar viaje · Ns" overlap.
    overflow: 'hidden',
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  countText: {
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
  },
  countBadge: {
    backgroundColor: colors.brand.orange,
    borderRadius: 12,
    minWidth: 26,
    height: 26,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
  },
  countBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  // ── Driver hero (count === 1) ──
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    marginBottom: 4,
  },
  heroAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  heroInitials: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brand.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroInitialsText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  heroName: {
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  heroRatingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  heroRatingText: {
    color: colors.warning.DEFAULT,
    fontSize: 11,
    fontWeight: '700',
  },
  heroService: {
    fontSize: 12,
    marginTop: 2,
  },
  // ── Multi-driver chips ──
  chipScroll: {
    paddingBottom: 6,
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 22,
    paddingVertical: 6,
    paddingHorizontal: 10,
    gap: 6,
    borderWidth: 1,
  },
  chipAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
  },
  chipInitials: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.brand.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipInitialsText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  chipName: {
    fontSize: 13,
    fontWeight: '600',
    maxWidth: 72,
  },
  chipRating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  chipRatingText: {
    fontSize: 11,
    fontWeight: '600',
  },
  // ── Trip summary block ──
  summary: {
    borderTopWidth: 1,
    marginTop: 10,
    paddingTop: 12,
    gap: 8,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  summaryDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  summaryRowText: {
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  summaryFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    borderTopWidth: 1,
    paddingTop: 10,
    marginTop: 4,
  },
  summaryFooterLabel: {
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 2,
  },
  summaryFooterValue: {
    fontSize: 14,
    fontWeight: '700',
  },
});
