import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';

export default function ReviewScreen() {
  const { t } = useTranslation('driver');

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <Text variant="h3" className="mb-1">
          {t('onboarding.step_review')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          Paso 4 de 4
        </Text>

        <Card variant="filled" padding="md" className="mb-4">
          <Text variant="label" color="secondary" className="mb-1">
            Datos personales
          </Text>
          <Text variant="body">Pendiente de completar</Text>
        </Card>

        <Card variant="filled" padding="md" className="mb-4">
          <Text variant="label" color="secondary" className="mb-1">
            Vehículo
          </Text>
          <Text variant="body">Pendiente de completar</Text>
        </Card>

        <Card variant="filled" padding="md" className="mb-6">
          <Text variant="label" color="secondary" className="mb-1">
            Documentos
          </Text>
          <Text variant="body">0 de 5 subidos</Text>
        </Card>

        <Button
          title={t('onboarding.submit')}
          size="lg"
          fullWidth
          onPress={() => {
            // TODO: Submit for verification
            router.replace('/(tabs)');
          }}
        />
      </View>
    </Screen>
  );
}
