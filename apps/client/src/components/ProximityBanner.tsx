import React, { useEffect, useRef } from 'react';
import { Pressable, Animated, StyleSheet } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';

interface ProximityBannerProps {
  /** Type of proximity alert */
  type: 'pickup' | 'dropoff';
  /** Driver name (only used for pickup type) */
  driverName?: string | null;
  /** Current ETA in minutes */
  etaMinutes: number;
  /** Called when banner is dismissed (tap or auto) */
  onDismiss: () => void;
}

const COLORS = {
  pickup: '#0EA5E9',  // sky-500
  dropoff: '#8B5CF6', // violet-500
};

const ICONS = {
  pickup: 'car-outline' as const,
  dropoff: 'location-outline' as const,
};

/**
 * Animated proximity banner that slides in from the top.
 * Shows when driver is ~2 minutes from pickup or destination.
 */
export function ProximityBanner({ type, driverName, etaMinutes, onDismiss }: ProximityBannerProps) {
  const { t } = useTranslation('rider');
  const slideAnim = useRef(new Animated.Value(-100)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    // Slide in + fade in
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 65,
        friction: 8,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();
  }, [slideAnim, opacityAnim]);

  const handleDismiss = () => {
    Animated.timing(opacityAnim, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => onDismissRef.current());
  };

  const title = type === 'pickup'
    ? t('ride.driver_approaching_title', { defaultValue: 'Driver nearby' })
    : t('ride.approaching_destination_title', { defaultValue: 'Arriving at destination' });

  const body = type === 'pickup'
    ? t('ride.driver_approaching_body', { name: driverName ?? '', defaultValue: '{{name}} is ~2 minutes from pickup' })
    : t('ride.approaching_destination_body', { defaultValue: "You're ~2 minutes from your destination" });

  const bgColor = COLORS[type];
  const icon = ICONS[type];

  return (
    <Pressable
      onPress={handleDismiss}
      style={styles.wrapper}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Animated.View
        style={[
          styles.banner,
          {
            backgroundColor: bgColor,
            opacity: opacityAnim,
            transform: [{ translateY: slideAnim }],
          },
        ]}
      >
        <Ionicons name={icon} size={22} color="#fff" style={styles.icon} />
        <Animated.View style={styles.textContainer}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.body} numberOfLines={1}>{body}</Text>
        </Animated.View>
        <Text style={styles.etaBadge}>{etaMinutes === 0 ? '< 1 min' : `~${etaMinutes} min`}</Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 99,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  icon: {
    marginRight: 12,
  },
  textContainer: {
    flex: 1,
  },
  title: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  body: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    marginTop: 1,
  },
  etaBadge: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    overflow: 'hidden',
    marginLeft: 8,
  },
});
