import React, { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { useOnboardingStore } from '@/stores/onboarding.store';
import { isValidEmail, sanitizeText } from '@tricigo/utils';

function useSteps() {
  const { t } = useTranslation('driver');
  return [
    { key: 'personal', label: t('onboarding.step_personal', { defaultValue: 'Personal' }) },
    { key: 'vehicle', label: t('onboarding.step_vehicle', { defaultValue: 'Vehículo' }) },
    { key: 'documents', label: t('onboarding.step_docs', { defaultValue: 'Docs' }) },
    { key: 'review', label: t('onboarding.step_review', { defaultValue: 'Revisión' }) },
  ];
}

export default function PersonalInfoScreen() {
  const { t } = useTranslation('driver');
  const STEPS = useSteps();
  const user = useAuthStore((s) => s.user);
  const { personalInfo, setPersonalInfo } = useOnboardingStore();

  const [fullName, setFullName] = useState(personalInfo.full_name || user?.full_name || '');
  const [email, setEmail] = useState(personalInfo.email || user?.email || '');
  const [errors, setErrors] = useState<{ fullName?: string; email?: string }>({});

  const validate = (): boolean => {
    const newErrors: { fullName?: string; email?: string } = {};
    const trimmedName = sanitizeText(fullName);
    if (!trimmedName || trimmedName.length < 2) {
      newErrors.fullName = t('onboarding.error_name_required');
    }
    if (email.trim() && !isValidEmail(email.trim())) {
      newErrors.email = t('onboarding.error_invalid_email');
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    if (!validate()) return;
    setPersonalInfo({ full_name: sanitizeText(fullName), email: email.trim() });
    router.push('/onboarding/vehicle-info');
  };

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <StatusStepper steps={STEPS} currentStep="personal" className="mb-6" />

        <Text variant="h3" className="mb-1">
          {t('onboarding.step_personal')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          {t('onboarding.step_n_of_total', { step: 1, total: 4 })}
        </Text>

        <Input
          label={t('onboarding.full_name')}
          placeholder="Juan Pérez"
          value={fullName}
          onChangeText={setFullName}
          error={errors.fullName}
          autoFocus
        />
        <Input
          label={t('onboarding.phone')}
          value={user?.phone ?? ''}
          editable={false}
        />
        <Input
          label={t('onboarding.email')}
          placeholder="email@ejemplo.com"
          keyboardType="email-address"
          autoCapitalize="none"
          value={email}
          onChangeText={setEmail}
          error={errors.email}
        />

        <Button
          title={t('common:next')}
          size="lg"
          fullWidth
          className="mt-4"
          onPress={handleNext}
        />
      </View>
    </Screen>
  );
}
