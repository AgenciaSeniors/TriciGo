import React from 'react';
import { View } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';

export default function TripsScreen() {
  const { t } = useTranslation('driver');

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <Text variant="h3" color="inverse" className="mb-4">
          {t('trips_history.title')}
        </Text>
        <View className="items-center py-20">
          <Text variant="body" color="inverse" className="opacity-50">
            {t('trips_history.no_trips')}
          </Text>
        </View>
      </View>
    </Screen>
  );
}
