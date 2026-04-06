// ============================================================
// TriciGo — AcceptedDriverCard
// Full-width celebration card shown when a driver accepts.
// Spring-bounce animation, then auto-transitions to active view.
// ============================================================

import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, StyleSheet } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';
import { getInitials } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import type { DriverAcceptedBroadcast } from '@tricigo/types';

interface AcceptedDriverCardProps {
  driver: DriverAcceptedBroadcast;
  onAnimationComplete: () => void;
}

/** Duration before we call onAnimationComplete (ms) */
const AUTO_TRANSITION_MS = 2000;

export function AcceptedDriverCard({ driver, onAnimationComplete }: AcceptedDriverCardProps) {
  const { t } = useTranslation('rider');

  const scaleAnim = useRef(new Animated.Value(0.3)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const checkScaleAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Card spring-in
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 5,
        tension: 60,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();

    // Checkmark bounce (delayed)
    const checkTimer = setTimeout(() => {
      Animated.spring(checkScaleAnim, {
        toValue: 1,
        friction: 4,
        tension: 80,
        useNativeDriver: true,
      }).start();
    }, 400);

    // Auto-transition after duration
    const transitionTimer = setTimeout(() => {
      onAnimationComplete();
    }, AUTO_TRANSITION_MS);

    return () => {
      clearTimeout(checkTimer);
      clearTimeout(transitionTimer);
    };
  }, [scaleAnim, opacityAnim, checkScaleAnim, onAnimationComplete]);

  // Build vehicle description
  const vehicleDesc = [
    driver.vehicleMake,
    driver.vehicleModel,
    driver.vehicleColor ? `- ${driver.vehicleColor}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Animated.View
      style={[
        styles.container,
        {
          opacity: opacityAnim,
          transform: [{ scale: scaleAnim }],
        },
      ]}
    >
      {/* Success checkmark */}
      <Animated.View
        style={[
          styles.checkContainer,
          { transform: [{ scale: checkScaleAnim }] },
        ]}
      >
        <Ionicons name="checkmark-circle" size={40} color={colors.success.DEFAULT} />
      </Animated.View>

      {/* Title */}
      <Text style={styles.title}>{t('searching.accepted_title')}</Text>
      <Text style={styles.subtitle}>
        {t('searching.accepted_subtitle', { name: driver.name })}
      </Text>

      {/* Driver info row */}
      <View style={styles.driverRow}>
        {/* Avatar */}
        {driver.avatarUrl ? (
          <Image source={{ uri: driver.avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={styles.avatarFallback}>
            <Text style={styles.avatarInitials}>{getInitials(driver.name)}</Text>
          </View>
        )}

        {/* Name + rating + vehicle */}
        <View style={styles.driverInfo}>
          <Text style={styles.driverName}>{driver.name}</Text>
          <View style={styles.ratingRow}>
            <Ionicons name="star" size={14} color={colors.warning.DEFAULT} />
            <Text style={styles.ratingText}>{driver.rating.toFixed(1)}</Text>
          </View>
          {vehicleDesc ? (
            <Text style={styles.vehicleText} numberOfLines={1}>
              {vehicleDesc}
            </Text>
          ) : null}
          {driver.vehiclePlate ? (
            <View style={styles.plateBadge}>
              <Text style={styles.plateText}>{driver.vehiclePlate}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(17, 17, 17, 0.97)',
    borderRadius: 20,
    padding: 20,
    marginHorizontal: 16,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.success.DEFAULT + '40',
    shadowColor: colors.success.DEFAULT,
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  checkContainer: {
    marginBottom: 8,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    color: colors.neutral[400],
    fontSize: 14,
    marginBottom: 16,
  },
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 14,
    padding: 12,
    gap: 12,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: colors.success.DEFAULT,
  },
  avatarFallback: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brand.orange,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.success.DEFAULT,
  },
  avatarInitials: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  driverInfo: {
    flex: 1,
  },
  driverName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 2,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  ratingText: {
    color: colors.neutral[300],
    fontSize: 13,
    fontWeight: '600',
  },
  vehicleText: {
    color: colors.neutral[400],
    fontSize: 12,
  },
  plateBadge: {
    backgroundColor: colors.neutral[800],
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  plateText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
