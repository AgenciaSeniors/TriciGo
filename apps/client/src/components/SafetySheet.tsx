import React, { useState, useEffect } from 'react';
import { View, Pressable, Linking, Alert, Share, ActivityIndicator, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { incidentService, rideService, trustedContactService, notificationService } from '@tricigo/api';
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
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [sharing, setSharing] = useState(false);
  const [sharingWithContacts, setSharingWithContacts] = useState(false);
  const [contactsSent, setContactsSent] = useState(false);
  const [autoShareContacts, setAutoShareContacts] = useState<TrustedContact[]>([]);

  useEffect(() => {
    if (!visible || !userId) return;
    trustedContactService.getAutoShareContacts(userId).then(setAutoShareContacts).catch(() => {});
    setContactsSent(false);
  }, [visible, userId]);

  const handleSOS = () => {
    onClose();
    Alert.alert(
      tr('ride.sos_title'),
      tr('ride.sos_body'),
      [
        { text: tr('ride.sos_cancel'), style: 'cancel' },
        {
          text: tr('ride.sos_call_emergency'),
          style: 'destructive',
          onPress: async () => {
            incidentService.createSOSReport({
              ride_id: rideId,
              reported_by: userId,
              against_user_id: driverId ?? undefined,
              description: 'SOS activado por pasajero durante viaje',
            }).catch(() => {});
            Linking.openURL('tel:106');
          },
        },
      ],
    );
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

  const handleShareWithContacts = async () => {
    if (autoShareContacts.length === 0) {
      onClose();
      router.push('/profile/trusted-contacts');
      return;
    }
    setSharingWithContacts(true);
    try {
      let token = await rideService.getShareTokenForRide(rideId);
      if (!token) {
        token = await rideService.generateShareToken(rideId);
      }
      const url = `https://tricigo.app/track/share/${token}`;

      // Notify trusted contacts via SMS (fire-and-forget)
      const userName = emergencyContact?.name ?? t('safety.someone');
      notificationService.notifyTrustedContacts({
        contacts: autoShareContacts.map((c) => ({ name: c.name, phone: c.phone })),
        message: `\u{1F4CD} ${userName} est\u00e1 en un viaje. Sigue su ubicaci\u00f3n en tiempo real: ${url}`,
        eventType: 'trip_shared',
      }).catch(() => {});

      setContactsSent(true);
    } catch {
      // Share generation failed
    } finally {
      setSharingWithContacts(false);
    }
  };

  const handleCallContact = () => {
    if (emergencyContact?.phone) {
      Linking.openURL(`tel:${emergencyContact.phone}`);
    } else {
      onClose();
      router.push('/profile/emergency-contact');
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text variant="h4" className="mb-4">
        {t('safety.title')}
      </Text>

      {/* Call Driver (4.5) — only shown when driver phone is available */}
      {driverPhone && (
        <Pressable
          className="flex-row items-center py-4 border-b border-neutral-100"
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

      {/* SOS - Call Emergency */}
      <Pressable
        className="flex-row items-center py-4 border-b border-neutral-100"
        onPress={handleSOS}
        accessibilityRole="button"
        accessibilityLabel={tr('ride.sos_activate')}
      >
        <View className="w-10 h-10 rounded-full bg-error items-center justify-center mr-3">
          <Ionicons name="warning" size={20} color="white" />
        </View>
        <View className="flex-1">
          <Text variant="body" className="font-semibold">
            {t('safety.emergency_call')}
          </Text>
          <Text variant="caption" color="secondary">
            {t('safety.emergency_call_desc')}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
      </Pressable>

      {/* Share Trip */}
      <Pressable
        className="flex-row items-center py-4 border-b border-neutral-100"
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
          <Text variant="caption" color="secondary">
            {sharing ? t('safety.share_trip_sharing') : t('safety.share_trip_desc')}
          </Text>
        </View>
        {sharing ? (
          <ActivityIndicator size="small" color={colors.primary[500]} />
        ) : (
          <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
        )}
      </Pressable>

      {/* Share with Trusted Contacts */}
      <Pressable
        className="flex-row items-center py-4 border-b border-neutral-100"
        onPress={handleShareWithContacts}
        disabled={sharingWithContacts || contactsSent}
        accessibilityRole="button"
        accessibilityLabel={tr('ride.share_with_contacts')}
      >
        <View className="w-10 h-10 rounded-full bg-primary-100 items-center justify-center mr-3">
          <Ionicons name="people-outline" size={20} color={colors.primary[500]} />
        </View>
        <View className="flex-1">
          <Text variant="body" className="font-semibold">
            {t('safety.share_with_contacts')}
          </Text>
          <Text variant="caption" color="secondary">
            {contactsSent
              ? t('safety.share_sent_to_n', { count: autoShareContacts.length })
              : autoShareContacts.length > 0
                ? t('safety.share_with_contacts_desc', { count: autoShareContacts.length })
                : t('safety.no_trusted_contacts')}
          </Text>
        </View>
        {sharingWithContacts ? (
          <ActivityIndicator size="small" color={colors.primary[500]} />
        ) : contactsSent ? (
          <Ionicons name="checkmark-circle" size={20} color={isDark ? '#4ADE80' : '#16A34A'} />
        ) : (
          <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
        )}
      </Pressable>

      {/* Call Emergency Contact */}
      <Pressable
        className="flex-row items-center py-4 border-b border-neutral-100"
        onPress={handleCallContact}
        accessibilityRole="button"
        accessibilityLabel={tr('ride.call_emergency')}
      >
        <View className="w-10 h-10 rounded-full bg-primary-100 items-center justify-center mr-3">
          <Ionicons name="call-outline" size={20} color={colors.primary[500]} />
        </View>
        <View className="flex-1">
          <Text variant="body" className="font-semibold">
            {emergencyContact
              ? `${t('safety.call_contact')}: ${emergencyContact.name}`
              : t('safety.set_emergency_contact')}
          </Text>
          <Text variant="caption" color="secondary">
            {emergencyContact
              ? emergencyContact.phone
              : t('safety.emergency_contact_desc')}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
      </Pressable>

      {/* Report Issue (disabled during ride) */}
      <View className="flex-row items-center py-4 opacity-40">
        <View className="w-10 h-10 rounded-full bg-neutral-100 items-center justify-center mr-3">
          <Ionicons name="flag-outline" size={20} color={colors.neutral[500]} />
        </View>
        <View className="flex-1">
          <Text variant="body" className="font-semibold">
            {t('safety.report')}
          </Text>
          <Text variant="caption" color="secondary">
            {t('safety.report_after_trip')}
          </Text>
        </View>
      </View>
    </BottomSheet>
  );
}
