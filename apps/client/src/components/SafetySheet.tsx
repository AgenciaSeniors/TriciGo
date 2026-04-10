import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Pressable, Linking, Share, ActivityIndicator, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import Toast from 'react-native-toast-message';
import { incidentService, rideService, trustedContactService, notificationService } from '@tricigo/api';
import { logger, triggerHaptic, buildShareUrl } from '@tricigo/utils';
import type { TrustedContact } from '@tricigo/types';

interface SafetySheetProps {
  visible: boolean;
  onClose: () => void;
  rideId: string;
  driverId: string | null;
  userId: string;
  emergencyContact: { name: string; phone: string } | null;
  driverPhone?: string | null;
}

export function SafetySheet({
  visible,
  onClose,
  rideId,
  driverId,
  userId,
  emergencyContact,
  driverPhone,
}: SafetySheetProps) {
  const { t } = useTranslation('common');
  const { t: tr } = useTranslation('rider');
  const [sharing, setSharing] = useState(false);
  const [autoShareContacts, setAutoShareContacts] = useState<TrustedContact[]>([]);

  useEffect(() => {
    if (!visible || !userId) return;
    trustedContactService.getAutoShareContacts(userId).then(setAutoShareContacts).catch(() => {});
  }, [visible, userId]);

  const notifyTrustedContacts = useCallback(async () => {
    if (autoShareContacts.length === 0) return;
    try {
      let token = await rideService.getShareTokenForRide(rideId);
      if (!token) {
        token = await rideService.generateShareToken(rideId);
      }
      const url = buildShareUrl(token);
      const userName = emergencyContact?.name ?? t('safety.someone');
      await notificationService.notifyTrustedContacts({
        contacts: autoShareContacts.map((c) => ({ name: c.name, phone: c.phone })),
        message: `\u{1F6A8} SOS: ${userName} activó emergencia durante un viaje. Ubicación: ${url}`,
        eventType: 'sos_emergency',
      });
    } catch (err) {
      logger.error('Failed to notify trusted contacts during SOS', { error: String(err) });
    }
  }, [autoShareContacts, rideId, emergencyContact, t]);

  const handleSOS = useCallback(async () => {
    onClose();

    // Haptic feedback immediately
    triggerHaptic('heavy');

    // Call emergency number immediately
    Linking.openURL('tel:106');

    // Simultaneously notify contacts and create report
    notifyTrustedContacts();

    incidentService.createSOSReport({
      ride_id: rideId,
      reported_by: userId,
      against_user_id: driverId ?? undefined,
      description: 'SOS activado por pasajero durante viaje',
    }).catch((err) => {
      logger.error('SOS report failed', { error: String(err) });
    });

    // Show confirmation toast
    Toast.show({
      type: 'success',
      text1: tr('ride.sos_activated'),
    });
  }, [onClose, notifyTrustedContacts, rideId, userId, driverId, tr]);

  // ── SOS long-press state (2s hold to activate) ──
  const [sosHolding, setSosHolding] = useState(false);
  const sosProgress = useRef(new Animated.Value(0)).current;
  const sosTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSOSPressIn = useCallback(() => {
    setSosHolding(true);
    triggerHaptic('light');
    Animated.timing(sosProgress, {
      toValue: 1,
      duration: 2000,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
    sosTimerRef.current = setTimeout(() => {
      setSosHolding(false);
      sosProgress.setValue(0);
      handleSOS();
    }, 2000);
  }, [sosProgress, handleSOS]);

  const handleSOSPressOut = useCallback(() => {
    if (sosTimerRef.current) {
      clearTimeout(sosTimerRef.current);
      sosTimerRef.current = null;
    }
    setSosHolding(false);
    sosProgress.setValue(0);
  }, [sosProgress]);

  useEffect(() => {
    return () => {
      if (sosTimerRef.current) clearTimeout(sosTimerRef.current);
    };
  }, []);

  const handleShareTrip = async () => {
    setSharing(true);
    try {
      let token = await rideService.getShareTokenForRide(rideId);
      if (!token) {
        token = await rideService.generateShareToken(rideId);
      }
      const url = buildShareUrl(token);
      await Share.share({
        message: t('safety.share_trip_message', { url }),
      });
    } catch (err: unknown) {
      // Share.share rejects on iOS if user cancels — ignore that
      const message = err instanceof Error ? err.message : '';
      if (message !== 'User did not share') {
        Toast.show({ type: 'error', text1: tr('ride.share_failed', { defaultValue: 'Error al compartir' }) });
      }
    } finally {
      setSharing(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text variant="h4" className="mb-4">
        {t('safety.title')}
      </Text>

      {/* ═══ TIER 1 — EMERGENCY (long-press 2s to activate) ═══ */}
      <View className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 mb-4">
        <Pressable
          onPressIn={handleSOSPressIn}
          onPressOut={handleSOSPressOut}
          style={{
            borderRadius: 12,
            overflow: 'hidden',
            backgroundColor: '#DC2626',
            paddingVertical: 16,
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
          }}
          accessibilityRole="button"
          accessibilityLabel={tr('ride.sos_hold', { defaultValue: 'Mantén presionado para SOS' })}
          accessibilityHint={tr('ride.sos_hold_hint', { defaultValue: 'Mantén presionado 2 segundos para activar emergencia' })}
        >
          {/* Progress overlay — fills left-to-right while holding */}
          <Animated.View
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              backgroundColor: '#991B1B',
              width: sosProgress.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            }}
          />
          <Text variant="h3" className="text-white text-center font-bold" style={{ zIndex: 1 }}>
            {sosHolding
              ? tr('ride.sos_holding', { defaultValue: 'Mantenga...' })
              : tr('ride.sos_full')}
          </Text>
        </Pressable>
        <Text variant="bodySmall" className="text-red-700 dark:text-red-400 text-center mt-2">
          {tr('ride.sos_hold_instruction', { defaultValue: 'Mantén presionado 2 seg para activar SOS' })}
        </Text>
      </View>

      {/* ═══ TIER 2 — PRECAUTION ═══ */}
      <Text variant="bodySmall" className="text-neutral-500 mb-2">
        {tr('ride.other_options')}
      </Text>

      {/* Share Trip */}
      <Pressable
        className="flex-row items-center py-3 border-b border-neutral-100"
        onPress={handleShareTrip}
        disabled={sharing}
        accessibilityRole="button"
        accessibilityLabel={tr('ride.share_location')}
      >
        <View className="w-10 h-10 rounded-full bg-primary-100 items-center justify-center mr-3">
          <Ionicons name="share-outline" size={20} color={colors.primary[500]} />
        </View>
        <View className="flex-1">
          <Text variant="body" className="font-semibold">
            {t('safety.share_trip')}
          </Text>
        </View>
        {sharing ? (
          <ActivityIndicator size="small" color={colors.primary[500]} />
        ) : (
          <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
        )}
      </Pressable>

      {/* Call Driver — only shown when driver phone is available */}
      {driverPhone && (
        <Pressable
          className="flex-row items-center py-3"
          onPress={() => Linking.openURL(`tel:${driverPhone}`)}
          accessibilityRole="button"
          accessibilityLabel={tr('ride.call_driver_full')}
        >
          <View className="w-10 h-10 rounded-full bg-primary-100 items-center justify-center mr-3">
            <Ionicons name="call-outline" size={20} color={colors.primary[500]} />
          </View>
          <View className="flex-1">
            <Text variant="body" className="font-semibold">
              {tr('ride.call_driver_full', { defaultValue: 'Llamar al conductor' })}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
        </Pressable>
      )}
    </BottomSheet>
  );
}
