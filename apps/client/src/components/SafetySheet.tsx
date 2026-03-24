import React, { useState, useEffect } from 'react';
import { View, Pressable, Linking, Share, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import Toast from 'react-native-toast-message';
import { incidentService, rideService, trustedContactService, notificationService } from '@tricigo/api';
import { logger, triggerHaptic } from '@tricigo/utils';
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

  const notifyTrustedContacts = async () => {
    if (autoShareContacts.length === 0) return;
    try {
      let token = await rideService.getShareTokenForRide(rideId);
      if (!token) {
        token = await rideService.generateShareToken(rideId);
      }
      const url = `https://tricigo.app/track/share/${token}`;
      const userName = emergencyContact?.name ?? t('safety.someone');
      await notificationService.notifyTrustedContacts({
        contacts: autoShareContacts.map((c) => ({ name: c.name, phone: c.phone })),
        message: `\u{1F6A8} SOS: ${userName} activó emergencia durante un viaje. Ubicación: ${url}`,
        eventType: 'sos_emergency',
      });
    } catch (err) {
      logger.error('Failed to notify trusted contacts during SOS', { error: String(err) });
    }
  };

  const handleSOS = async () => {
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
  };

  const handleShareTrip = async () => {
    setSharing(true);
    try {
      let token = await rideService.getShareTokenForRide(rideId);
      if (!token) {
        token = await rideService.generateShareToken(rideId);
      }
      const url = `https://tricigo.app/track/share/${token}`;
      await Share.share({
        message: t('safety.share_trip_message', { url }),
      });
    } catch {
      // Share dismissed or failed — no-op
    } finally {
      setSharing(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text variant="h4" className="mb-4">
        {t('safety.title')}
      </Text>

      {/* ═══ TIER 1 — EMERGENCY ═══ */}
      <View className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 mb-4">
        <Pressable
          className="bg-red-600 rounded-xl py-4 items-center justify-center w-full"
          onPress={handleSOS}
          accessibilityRole="button"
          accessibilityLabel={tr('ride.sos_full')}
        >
          <Text variant="h3" className="text-white text-center font-bold">
            {tr('ride.sos_full')}
          </Text>
        </Pressable>
        <Text variant="bodySmall" className="text-red-700 dark:text-red-400 text-center mt-2">
          {tr('ride.sos_auto_notify')}
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
