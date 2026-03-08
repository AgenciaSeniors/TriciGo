import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';

export default function DocumentsScreen() {
  const { t } = useTranslation('driver');

  const documents = [
    { key: 'national_id', label: t('onboarding.national_id'), uploaded: false },
    { key: 'drivers_license', label: t('onboarding.drivers_license'), uploaded: false },
    { key: 'vehicle_registration', label: t('onboarding.vehicle_registration'), uploaded: false },
    { key: 'selfie', label: t('onboarding.selfie'), uploaded: false },
    { key: 'vehicle_photo', label: t('onboarding.vehicle_photo'), uploaded: false },
  ];

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <Text variant="h3" className="mb-1">
          {t('onboarding.step_documents')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          Paso 3 de 4
        </Text>

        {documents.map((doc) => (
          <Pressable key={doc.key}>
            <Card variant="outlined" padding="md" className="mb-3 flex-row items-center">
              <Ionicons
                name={doc.uploaded ? 'checkmark-circle' : 'cloud-upload-outline'}
                size={24}
                color={doc.uploaded ? '#10B981' : '#A3A3A3'}
              />
              <View className="flex-1 ml-3">
                <Text variant="body">{doc.label}</Text>
                <Text variant="caption" color={doc.uploaded ? 'accent' : 'tertiary'}>
                  {doc.uploaded ? 'Subido' : t('onboarding.upload')}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color="#A3A3A3" />
            </Card>
          </Pressable>
        ))}

        <Button
          title="Siguiente"
          size="lg"
          fullWidth
          className="mt-4"
          onPress={() => router.push('/onboarding/review')}
        />
      </View>
    </Screen>
  );
}
