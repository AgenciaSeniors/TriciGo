import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';

export default function PersonalInfoScreen() {
  const { t } = useTranslation('driver');

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <Text variant="h3" className="mb-1">
          {t('onboarding.step_personal')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          Paso 1 de 4
        </Text>

        <Input label={t('onboarding.full_name')} placeholder="Juan Pérez" />
        <Input label={t('onboarding.phone')} placeholder="+53 5XXXXXXX" keyboardType="phone-pad" />
        <Input label={t('onboarding.email')} placeholder="email@ejemplo.com" keyboardType="email-address" />

        <Button
          title="Siguiente"
          size="lg"
          fullWidth
          className="mt-4"
          onPress={() => router.push('/onboarding/vehicle-info')}
        />
      </View>
    </Screen>
  );
}
