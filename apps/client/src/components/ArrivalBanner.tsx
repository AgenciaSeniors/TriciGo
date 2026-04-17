import React, { useEffect, useRef } from 'react';
import { Pressable, Animated, StyleSheet } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';

interface ArrivalBannerProps {
  /** Type of arrival event */
  type: 'pickup_arrival' | 'destination_arrival';
  /** Driver name (only used for pickup_arrival type) */
  driverName?: string | null;
  /** Vehicle description, e.g. "Honda Wave Azul · ABC-123" (only used for pickup_arrival type) */
  vehicleDescription?: string | null;
  /** Called when banner is dismissed (tap or auto) */
  onDismiss: () => void;
}

const COLORS = {
  pickup_arrival: '#0EA5E9',   // sky-500
  destination_arrival: '#16A34A', // green-600
};

const ICONS = {
  pickup_arrival: 'car-outline' as const,
  destination_arrival: 'checkmark-circle-outline' as const,
};

/** Auto-dismiss timeout in milliseconds */
const AUTO_DISMISS_MS = 10_000;

/**
 * Animated arrival banner that slides in from the top.
 * Shows when the driver arrives at pickup or the rider reaches the destination.
 */
export function ArrivalBanner({ type, driverName, vehicleDescription, onDismiss }: ArrivalBannerProps) {
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

    // Auto-dismiss after 10 seconds
    const timer = setTimeout(() => {
      handleDismiss();
    }, AUTO_DISMISS_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideAnim, opacityAnim]);

  const handleDismiss = () => {
    Animated.timing(opacityAnim, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => onDismissRef.current());
  };

  const title = type === 'pickup_arrival'
    ? t('ride.pickup_arrival_title', { defaultValue: 'Your driver is here' })
    : t('ride.arrived_at_destination_title', { defaultValue: "You've arrived" });

  const body = type === 'pickup_arrival'
    ? t('ride.pickup_arrival_body', {
        name: driverName ?? '',
        vehicle: vehicleDescription ?? '',
        defaultValue: '{{name}} is waiting in {{vehicle}}',
      })
    : '';

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
          {body !== '' && (
            <Text style={styles.body} numberOfLines={1}>{body}</Text>
          )}
        </Animated.View>
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
});
