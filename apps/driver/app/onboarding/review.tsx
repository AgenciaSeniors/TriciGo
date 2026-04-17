import React, { useState } from 'react';
import { View, Image } from 'react-native';
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

function useSteps() {
  const { t } = useTranslation('driver');
  return [
    { key: 'personal', label: t('onboarding.step_personal', { defaultValue: 'Personal' }) },
    { key: 'vehicle', label: t('onboarding.step_vehicle', { defaultValue: 'Vehículo' }) },
    { key: 'documents', label: t('onboarding.step_docs', { defaultValue: 'Docs' }) },
    { key: 'review', label: t('onboarding.step_review', { defaultValue: 'Revisión' }) },
  ];
}

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  triciclo: 'Triciclo',
  moto: 'Moto',
  auto: 'Auto',
};

const VEHICLE_IMAGES: Record<string, any> = {
  triciclo_basico: require('../../assets/vehicles/selection/triciclo.png'),
  moto_standard: require('../../assets/vehicles/selection/moto.png'),
  auto_standard: require('../../assets/vehicles/selection/auto.png'),
  auto_confort: require('../../assets/vehicles/selection/confort.png'),
};

export default function ReviewScreen() {
  const { t } = useTranslation('driver');
  const STEPS = useSteps();
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
        phone: personalInfo.phone || undefined,
      });

      // 2. Save personal identity info to driver_profiles
      await driverService.updatePersonalInfo(driverProfileId, {
        identity_number: personalInfo.identity_number || undefined,
        address: personalInfo.address || undefined,
        province: personalInfo.province || undefined,
        municipality: personalInfo.municipality || undefined,
        has_criminal_record: personalInfo.has_criminal_record,
        criminal_record_details: personalInfo.has_criminal_record ? personalInfo.criminal_record_details || undefined : undefined,
      });

      // 3. Register vehicle
      await driverService.registerVehicle({
        driver_id: driverProfileId,
        type: vehicle.type as VehicleType,
        make: vehicle.make,
        model: vehicle.model,
        year: parseInt(vehicle.year, 10),
        color: vehicle.color,
        plate_number: vehicle.plate_number,
        capacity: parseInt(vehicle.capacity, 10),
        accepts_cargo: vehicle.accepts_cargo,
        max_cargo_weight_kg: vehicle.accepts_cargo && vehicle.max_cargo_weight_kg ? parseFloat(vehicle.max_cargo_weight_kg) : null,
        max_cargo_length_cm: vehicle.accepts_cargo && vehicle.max_cargo_length_cm ? parseInt(vehicle.max_cargo_length_cm, 10) : null,
        max_cargo_width_cm: vehicle.accepts_cargo && vehicle.max_cargo_width_cm ? parseInt(vehicle.max_cargo_width_cm, 10) : null,
        max_cargo_height_cm: vehicle.accepts_cargo && vehicle.max_cargo_height_cm ? parseInt(vehicle.max_cargo_height_cm, 10) : null,
        accepted_cargo_categories: vehicle.accepts_cargo ? vehicle.accepted_cargo_categories : [],
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
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <StatusStepper steps={STEPS} currentStep="review" className="mb-6" />

        <Text variant="h3" color="inverse" className="mb-1">
          {t('onboarding.step_review')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          {t('onboarding.step_n_of_total', { step: 4, total: 4 })}
        </Text>

        {/* Personal Info */}
        <Card forceDark variant="surface" padding="md" className="mb-4">
          <Text variant="label" color="secondary" className="mb-2">
            {t('onboarding.personal_info_summary')}
          </Text>
          <Text variant="body" color="inverse">{personalInfo.full_name}</Text>
          <Text variant="bodySmall" color="secondary">{personalInfo.phone || user?.phone}</Text>
          {personalInfo.email ? (
            <Text variant="bodySmall" color="secondary">{personalInfo.email}</Text>
          ) : null}
        </Card>

        {/* Vehicle — Visual card with image */}
        <Card forceDark variant="surface" padding="md" className="mb-4">
          <Text variant="label" color="secondary" className="mb-3">
            {t('onboarding.vehicle_summary')}
          </Text>
          <View className="flex-row items-center mb-3">
            {vehicle.service_type_slug && VEHICLE_IMAGES[vehicle.service_type_slug] && (
              <Image
                source={VEHICLE_IMAGES[vehicle.service_type_slug]}
                style={{ width: 64, height: 64, marginRight: 12 }}
                resizeMode="contain"
              />
            )}
            <View className="flex-1">
              <Text variant="body" color="inverse" className="font-bold">
                {vehicle.service_type_slug === 'auto_confort' ? 'Confort' : VEHICLE_TYPE_LABELS[vehicle.type ?? ''] ?? ''}
              </Text>
              <Text variant="bodySmall" color="secondary">
                {vehicle.make} {vehicle.model} ({vehicle.year})
              </Text>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-2 mb-2">
            <View className="bg-[#252540] px-3 py-1.5 rounded-full">
              <Text variant="caption" color="inverse">{vehicle.color}</Text>
            </View>
            <View className="bg-[#252540] px-3 py-1.5 rounded-full">
              <Text variant="caption" color="inverse">{vehicle.plate_number}</Text>
            </View>
            <View className="bg-[#252540] px-3 py-1.5 rounded-full flex-row items-center gap-1">
              <Ionicons name="people" size={12} color="#A3A3A3" />
              <Text variant="caption" color="inverse">{vehicle.capacity} pasajeros</Text>
            </View>
          </View>
          {vehicle.accepts_cargo && (
            <View className="flex-row items-center bg-primary-500/10 rounded-lg px-3 py-2 mt-1">
              <Ionicons name="cube" size={14} color="#FF4D00" />
              <Text variant="caption" color="accent" className="ml-2">
                {t('onboarding.accepts_deliveries')} — Max {vehicle.max_cargo_weight_kg} kg
              </Text>
            </View>
          )}
        </Card>

        {/* Documents */}
        <Card forceDark variant="surface" padding="md" className="mb-6">
          <Text variant="label" color="secondary" className="mb-2">
            {t('onboarding.documents_summary')}
          </Text>
          <View className="flex-row items-center">
            <Ionicons
              name={uploadedCount === 5 ? 'checkmark-circle' : 'alert-circle'}
              size={20}
              color={uploadedCount === 5 ? '#22C55E' : '#F59E0B'}
            />
            <Text variant="body" color="inverse" className="ml-2">
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
