import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';

export default function VehicleInfoScreen() {
  const { t } = useTranslation('driver');

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <Text variant="h3" className="mb-1">
          {t('onboarding.step_vehicle')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          Paso 2 de 4
        </Text>

        <Input label={t('onboarding.vehicle_make')} placeholder="Marca" />
        <Input label={t('onboarding.vehicle_model')} placeholder="Modelo" />
        <Input label={t('onboarding.vehicle_year')} placeholder="2024" keyboardType="number-pad" />
        <Input label={t('onboarding.vehicle_color')} placeholder="Color" />
        <Input label={t('onboarding.plate_number')} placeholder="P123456" autoCapitalize="characters" />

        <Button
          title="Siguiente"
          size="lg"
          fullWidth
          className="mt-4"
          onPress={() => router.push('/onboarding/documents')}
        />
      </View>
    </Screen>
  );
}
