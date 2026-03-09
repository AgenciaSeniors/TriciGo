import React from 'react';
import { Stack } from 'expo-router';
import { useTranslation } from '@tricigo/i18n';

export default function OnboardingLayout() {
  const { t } = useTranslation('driver');

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: '#111111' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: 'bold' },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="personal-info" options={{ title: t('onboarding.step_personal') }} />
      <Stack.Screen name="vehicle-info" options={{ title: t('onboarding.step_vehicle') }} />
      <Stack.Screen name="documents" options={{ title: t('onboarding.step_documents') }} />
      <Stack.Screen name="review" options={{ title: t('onboarding.step_review') }} />
      <Stack.Screen name="pending" options={{ title: '', headerBackVisible: false, headerLeft: () => null }} />
    </Stack>
  );
}
