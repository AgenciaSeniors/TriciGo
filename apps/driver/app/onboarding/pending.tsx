import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';

export default function PendingScreen() {
  const { t } = useTranslation('driver');

  return (
    <Screen bg="dark" statusBarStyle="light-content">
      <View className="flex-1 justify-center items-center px-8">
        <Ionicons name="time-outline" size={80} color={colors.brand.orange} />
        <Text variant="h3" color="inverse" className="mt-6 text-center">
          {t('onboarding.pending_review')}
        </Text>
        <Text variant="body" color="inverse" className="mt-3 text-center opacity-60">
          {t('onboarding.pending_review_description')}
        </Text>
      </View>
    </Screen>
  );
}
