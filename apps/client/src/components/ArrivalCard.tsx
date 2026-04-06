import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, Pressable, StyleSheet } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';
import { getInitials } from '@tricigo/utils';

interface ArrivalCardProps {
  driverName: string;
  driverAvatarUrl?: string | null;
  vehiclePlate?: string | null;
  vehicleDescription?: string;
  onDismiss: () => void;
}

const AUTO_DISMISS_MS = 5000;

export function ArrivalCard({
  driverName,
  driverAvatarUrl,
  vehiclePlate,
  vehicleDescription,
  onDismiss,
}: ArrivalCardProps) {
  const { t } = useTranslation('rider');
  const slideAnim = useRef(new Animated.Value(300)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const checkScaleAnim = useRef(new Animated.Value(0)).current;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    // Slide up + fade in
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 60,
        friction: 7,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start();

    // Checkmark bounce (delayed)
    const checkTimer = setTimeout(() => {
      Animated.spring(checkScaleAnim, {
        toValue: 1,
        tension: 80,
        friction: 4,
        useNativeDriver: true,
      }).start();
    }, 300);

    // Auto-dismiss
    const dismissTimer = setTimeout(() => {
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start(() => onDismissRef.current());
    }, AUTO_DISMISS_MS);

    return () => {
      clearTimeout(checkTimer);
      clearTimeout(dismissTimer);
    };
  }, [slideAnim, opacityAnim, checkScaleAnim]); // eslint-disable-line react-hooks/exhaustive-deps — onDismiss stored in ref

  const handleTap = () => {
    Animated.timing(opacityAnim, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => onDismiss());
  };

  return (
    <Pressable onPress={handleTap} style={styles.overlay}>
      <Animated.View
        style={[
          styles.card,
          {
            opacity: opacityAnim,
            transform: [{ translateY: slideAnim }],
          },
        ]}
      >
        {/* Checkmark */}
        <Animated.View style={{ transform: [{ scale: checkScaleAnim }], marginBottom: 8 }}>
          <Ionicons name="checkmark-circle" size={48} color="#fff" />
        </Animated.View>

        {/* Title */}
        <Text style={styles.title}>{t('ride.driver_here_title', { defaultValue: 'Your driver is here!' })}</Text>
        <Text style={styles.subtitle}>{t('ride.driver_here_subtitle', { defaultValue: 'Head to the pickup point' })}</Text>

        {/* Driver info row */}
        <View style={styles.driverRow}>
          {driverAvatarUrl ? (
            <Image source={{ uri: driverAvatarUrl }} style={styles.avatar} />
          ) : (
            <View style={styles.avatarFallback}>
              <Text style={styles.avatarInitials}>{getInitials(driverName)}</Text>
            </View>
          )}
          <View style={styles.driverInfo}>
            <Text style={styles.driverName}>{driverName}</Text>
            {vehicleDescription ? (
              <Text style={styles.vehicleText} numberOfLines={1}>{vehicleDescription}</Text>
            ) : null}
            {vehiclePlate ? (
              <View style={styles.plateBadge}>
                <Text style={styles.plateText}>{vehiclePlate}</Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* Tap to dismiss hint */}
        <Text style={styles.dismissHint}>{t('ride.tap_to_dismiss', { defaultValue: 'Tap to dismiss' })}</Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  card: {
    backgroundColor: '#16A34A',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 10,
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 4,
    textAlign: 'center',
  },
  subtitle: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 14,
    marginBottom: 20,
    textAlign: 'center',
  },
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 14,
    padding: 12,
    gap: 12,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 3,
    borderColor: '#fff',
  },
  avatarFallback: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#fff',
  },
  avatarInitials: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
  },
  driverInfo: {
    flex: 1,
  },
  driverName: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 2,
  },
  vehicleText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    marginBottom: 4,
  },
  plateBadge: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  plateText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  dismissHint: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    marginTop: 12,
  },
});
