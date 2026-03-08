import React from 'react';
import { View } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';

export default function RidesScreen() {
  const { t } = useTranslation('rider');

  return (
    <Screen bg="white" padded>
      <View className="pt-4">
        <Text variant="h3" className="mb-4">
          {t('rides_history.title')}
        </Text>
        <View className="flex-1 items-center justify-center py-20">
          <Text variant="body" color="tertiary">
            {t('rides_history.no_rides')}
          </Text>
        </View>
      </View>
    </Screen>
  );
}
