/**
 * TripBadgesRow — extracted from DriverTripView for PR-A.
 *
 * Renders cargo and corporate ride badges. Each is independent — both
 * can be visible at the same time (corporate cargo trip).
 *
 * Visual + tokens preserved verbatim. PR-C will collapse these two ad-hoc
 * styles into a single `<Chip>` rail consistent with the IncomingRideCard.
 */
import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';

interface TripBadgesRowProps {
  isCargo: boolean;
  isCorporate: boolean;
}

export function TripBadgesRow({ isCargo, isCorporate }: TripBadgesRowProps) {
  const { t } = useTranslation('driver');

  if (!isCargo && !isCorporate) return null;

  return (
    <>
      {isCargo && (
        <View
          className="flex-row items-center justify-center mb-3 rounded-2xl py-2 px-4 border border-white/[0.06]"
          style={{ backgroundColor: '#FF4D00' }}
        >
          <Ionicons name="cube" size={16} color="white" />
          <Text variant="bodySmall" color="inverse" className="ml-2 font-bold">CARGO</Text>
        </View>
      )}
      {isCorporate && (
        <View className="flex-row items-center justify-center mb-3 bg-blue-600/80 rounded-2xl py-2 px-4 border border-white/[0.06]">
          <Ionicons name="business" size={16} color="white" />
          <Text variant="bodySmall" color="inverse" className="ml-2 font-bold">
            {t('home.corporate_ride')}
          </Text>
        </View>
      )}
    </>
  );
}
