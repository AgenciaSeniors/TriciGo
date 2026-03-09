import React, { useState } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { useTranslation } from '@tricigo/i18n';
import { authService, driverService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useOnboardingStore } from '@/stores/onboarding.store';
import type { VehicleType } from '@tricigo/types';

const STEPS = [
  { key: 'personal', label: 'Personal' },
  { key: 'vehicle', label: 'Vehículo' },
  { key: 'documents', label: 'Docs' },
  { key: 'review', label: 'Revisión' },
];

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  triciclo: 'Triciclo',
  moto: 'Moto',
  auto: 'Auto',
};

export default function ReviewScreen() {
  const { t } = useTranslation('driver');
  const user = useAuthStore((s) => s.user);
  const setProfile = useDriverStore((s) => s.setProfile);
  const { personalInfo, vehicle, documents, driverProfileId, reset } = useOnboardingStore();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const uploadedCount = documents.filter((d) => d.uploaded).length;

  const handleSubmit = async () => {
    if (!user || !driverProfileId) return;

    setSubmitting(true);
    setError('');
    try {
      // 1. Update user profile (name, email on users table)
      await authService.updateProfile(user.id, {
        full_name: personalInfo.full_name,
        email: personalInfo.email || null,
      });

      // 2. Register vehicle
      await driverService.registerVehicle({
        driver_id: driverProfileId,
        type: vehicle.type as VehicleType,
        make: vehicle.make,
        model: vehicle.model,
        year: parseInt(vehicle.year, 10),
        color: vehicle.color,
        plate_number: vehicle.plate_number,
        capacity: parseInt(vehicle.capacity, 10),
        is_active: true,
        photo_url: null,
      });

      // 3. Submit for verification (status → under_review)
      await driverService.submitForVerification(driverProfileId);

      // 4. Refresh driver profile in store
      const updatedProfile = await driverService.getProfile(user.id);
      if (updatedProfile) setProfile(updatedProfile);

      // 5. Update auth user in store
      const updatedUser = await authService.getCurrentUser();
      if (updatedUser) useAuthStore.getState().setUser(updatedUser);

      // 6. Clear onboarding draft
      reset();

      // 7. Navigate to pending
      router.replace('/onboarding/pending');
    } catch (err) {
      console.error('Onboarding submit error:', err);
      setError(t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <StatusStepper steps={STEPS} currentStep="review" className="mb-6" />

        <Text variant="h3" className="mb-1">
          {t('onboarding.step_review')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          {t('onboarding.step_n_of_total', { step: 4, total: 4 })}
        </Text>

        {/* Personal Info */}
        <Card variant="filled" padding="md" className="mb-4">
          <Text variant="label" color="secondary" className="mb-2">
            {t('onboarding.personal_info_summary')}
          </Text>
          <Text variant="body">{personalInfo.full_name}</Text>
          <Text variant="bodySmall" color="secondary">{user?.phone}</Text>
          {personalInfo.email ? (
            <Text variant="bodySmall" color="secondary">{personalInfo.email}</Text>
          ) : null}
        </Card>

        {/* Vehicle */}
        <Card variant="filled" padding="md" className="mb-4">
          <Text variant="label" color="secondary" className="mb-2">
            {t('onboarding.vehicle_summary')}
          </Text>
          <Text variant="body">
            {VEHICLE_TYPE_LABELS[vehicle.type ?? ''] ?? ''} — {vehicle.make} {vehicle.model} ({vehicle.year})
          </Text>
          <Text variant="bodySmall" color="secondary">
            {vehicle.color} | {vehicle.plate_number} | {vehicle.capacity} pasajeros
          </Text>
        </Card>

        {/* Documents */}
        <Card variant="filled" padding="md" className="mb-6">
          <Text variant="label" color="secondary" className="mb-2">
            {t('onboarding.documents_summary')}
          </Text>
          <View className="flex-row items-center">
            <Ionicons
              name={uploadedCount === 5 ? 'checkmark-circle' : 'alert-circle'}
              size={20}
              color={uploadedCount === 5 ? '#10B981' : '#F59E0B'}
            />
            <Text variant="body" className="ml-2">
              {t('onboarding.documents_count', { count: uploadedCount, total: 5 })}
            </Text>
          </View>
        </Card>

        {error ? (
          <Text variant="bodySmall" color="error" className="mb-4 text-center">{error}</Text>
        ) : null}

        <Button
          title={submitting ? t('onboarding.submitting') : t('onboarding.submit')}
          size="lg"
          fullWidth
          onPress={handleSubmit}
          loading={submitting}
          disabled={submitting || uploadedCount < 5 || !driverProfileId}
        />
      </View>
    </Screen>
  );
}
