import React, { useState } from 'react';
import { View, Image, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';
import { authService, driverService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useOnboardingStore } from '@/stores/onboarding.store';
import { SwitchAccountFooter } from '@/components/onboarding/SwitchAccountFooter';
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
  confort: 'Confort',
};

const VEHICLE_IMAGES: Record<string, any> = {
  triciclo_basico: require('../../assets/vehicles/selection/triciclo.png'),
  moto_standard: require('../../assets/vehicles/selection/moto.png'),
  // Mirror onboarding/vehicle-info.tsx: the Auto card uses the side-view
  // sedan from selection/ (matches triciclo/moto/confort). The top-down
  // almendrón marker stays on the live map only.
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
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Submit gates on REQUIRED docs only — optional ones (drivers_license) never
  // block. (Also why we never compare against a hardcoded count: CC-04 reduced
  // docs 5→4 and a hardcoded 5 left Submit permanently disabled — see #620.)
  const requiredDocs = documents.filter((d) => !d.optional);
  const requiredUploaded = requiredDocs.filter((d) => d.uploaded).length;
  const requiredTotal = requiredDocs.length;

  const handleSubmit = async () => {
    if (!user || !driverProfileId) return;

    // Guard against submitting an EMPTY draft. The onboarding store is in-memory,
    // so it starts blank whenever the Documents step is reached WITHOUT walking
    // steps 1–2 first — most notably a rejected driver tapping "Volver a subir
    // documentos" (pending.tsx), which jumps straight here. Submitting blank would
    // (a) overwrite users.full_name with '' — silent data loss — and then
    // (b) hard-fail in registerVehicle (vehicles.type is NOT NULL, year = NaN).
    // Bounce them to the earliest incomplete step instead. On the normal wizard
    // path both steps are already filled, so this never trips.
    if (!personalInfo.full_name.trim()) {
      Toast.show({
        type: 'info',
        text1: t('onboarding.complete_personal_first', { defaultValue: 'Primero completa tus datos personales.' }),
        visibilityTime: 3000,
      });
      router.replace('/onboarding/personal-info');
      return;
    }
    if (!vehicle.type || !vehicle.make.trim() || !vehicle.model.trim() || !vehicle.plate_number.trim() || !vehicle.year.trim()) {
      Toast.show({
        type: 'info',
        text1: t('onboarding.complete_vehicle_first', { defaultValue: 'Primero completa los datos de tu vehículo.' }),
        visibilityTime: 3000,
      });
      router.replace('/onboarding/vehicle-info');
      return;
    }

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

      // 3. Submit for verification (status → under_review). termsAccepted
      // stamps driver_profiles.terms_accepted_at in the same update — the
      // acceptance-contract trigger (00405) reads it to date the contract.
      await driverService.submitForVerification(driverProfileId, { termsAccepted });

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
      // Consistent with other onboarding screens: global toast in case
      // the inline red text is below the fold.
      Toast.show({ type: 'error', text1: t('errors.generic'), visibilityTime: 3000 });
    } finally {
      setSubmitting(false);
    }
  };

  // UX: tiny "Editar" header-action that jumps back to a specific step.
  // Without this, a driver who spots a typo has no visible way to fix it
  // short of killing the app and starting over.
  const EditLink = ({ step }: { step: 'personal-info' | 'vehicle-info' | 'documents' }) => (
    <Pressable
      onPress={() => router.push(`/onboarding/${step}`)}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('onboarding.edit_section', { defaultValue: 'Editar sección' })}
    >
      <Text variant="caption" style={{ color: midnightEmber.accent[500], fontWeight: '600' }}>
        {t('common.edit', { defaultValue: 'Editar' })}
      </Text>
    </Pressable>
  );

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <StatusStepper steps={STEPS} currentStep="review" className="mb-6" />

        <Text variant="h3" color="inverse" className="mb-1">
          {t('onboarding.step_review')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6" style={{ color: midnightEmber.map.text.secondary }}>
          {t('onboarding.step_n_of_total', { step: 4, total: 4 })}
        </Text>

        {/* Personal Info */}
        <Card forceDark variant="surface" padding="md" className="mb-4">
          <View className="flex-row items-center justify-between mb-2">
            <Text variant="label" color="secondary" style={{ color: midnightEmber.map.text.secondary }}>
              {t('onboarding.personal_info_summary')}
            </Text>
            <EditLink step="personal-info" />
          </View>
          <Text variant="body" color="inverse">{personalInfo.full_name}</Text>
          <Text variant="bodySmall" color="secondary" style={{ color: midnightEmber.map.text.secondary }}>{personalInfo.phone || user?.phone}</Text>
          {personalInfo.email ? (
            <Text variant="bodySmall" color="secondary" style={{ color: midnightEmber.map.text.secondary }}>{personalInfo.email}</Text>
          ) : null}
        </Card>

        {/* Vehicle — Visual card with image */}
        <Card forceDark variant="surface" padding="md" className="mb-4">
          <View className="flex-row items-center justify-between mb-3">
            <Text variant="label" color="secondary" style={{ color: midnightEmber.map.text.secondary }}>
              {t('onboarding.vehicle_summary')}
            </Text>
            <EditLink step="vehicle-info" />
          </View>
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
              <Text variant="bodySmall" color="secondary" style={{ color: midnightEmber.map.text.secondary }}>
                {vehicle.make} {vehicle.model} ({vehicle.year})
              </Text>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-2 mb-2">
            <View
              className="px-3 py-1.5 rounded-full"
              style={{ backgroundColor: midnightEmber.map.bg.elevated }}
            >
              <Text variant="caption" color="inverse">{vehicle.color}</Text>
            </View>
            <View
              className="px-3 py-1.5 rounded-full"
              style={{ backgroundColor: midnightEmber.map.bg.elevated }}
            >
              <Text variant="caption" color="inverse">{vehicle.plate_number}</Text>
            </View>
            <View
              className="px-3 py-1.5 rounded-full flex-row items-center gap-1"
              style={{ backgroundColor: midnightEmber.map.bg.elevated }}
            >
              <Ionicons name="people" size={12} color={midnightEmber.map.text.tertiary} />
              <Text variant="caption" color="inverse">{vehicle.capacity} pasajeros</Text>
            </View>
          </View>
          {vehicle.accepts_cargo && (
            <View
              className="flex-row items-center rounded-lg px-3 py-2 mt-1"
              style={{ backgroundColor: midnightEmber.accent.glow }}
            >
              <Ionicons name="cube" size={14} color={midnightEmber.accent[500]} />
              <Text variant="caption" color="accent" className="ml-2">
                {t('onboarding.accepts_deliveries')} — Max {vehicle.max_cargo_weight_kg} kg
              </Text>
            </View>
          )}
        </Card>

        {/* Documents */}
        <Card forceDark variant="surface" padding="md" className="mb-6">
          <View className="flex-row items-center justify-between mb-2">
            <Text variant="label" color="secondary" style={{ color: midnightEmber.map.text.secondary }}>
              {t('onboarding.documents_summary')}
            </Text>
            <EditLink step="documents" />
          </View>
          <View className="flex-row items-center">
            <Ionicons
              name={requiredUploaded === requiredTotal ? 'checkmark-circle' : 'alert-circle'}
              size={20}
              color={requiredUploaded === requiredTotal ? midnightEmber.state.success : midnightEmber.state.warning}
            />
            <Text variant="body" color="inverse" className="ml-2">
              {t('onboarding.documents_count', { count: requiredUploaded, total: requiredTotal })}
            </Text>
          </View>
        </Card>

        {/* OFAC defense disclaimer: clarify the legal nature of the
            wallet so the relationship between the driver, the platform,
            and the payment processor is unambiguous. The driver is an
            independent service provider; the wallet is internal account
            credit, not an international monetary transfer. */}
        <Card forceDark variant="surface" padding="md" className="mb-4">
          <View className="flex-row items-start gap-2">
            <Ionicons
              name="shield-checkmark-outline"
              size={18}
              color={midnightEmber.map.text.tertiary}
              style={{ marginTop: 2 }}
            />
            <View className="flex-1">
              <Text variant="caption" color="secondary" style={{ color: midnightEmber.map.text.secondary }}>
                {t('onboarding.legal_disclaimer', {
                  defaultValue:
                    'Al registrarte aceptas que TriciGo es una plataforma que conecta pasajeros y conductores independientes. Tu billetera es saldo interno canjeable por servicios de transporte físico — no es una transferencia internacional de dinero ni una cuenta bancaria.',
                })}
              </Text>
            </View>
          </View>
        </Card>

        {/* Explicit T&C acceptance (00405): the timestamp is stamped
            server-side in the same submit update, and the acceptance
            contract PDF is generated/emailed from it. Submit stays
            disabled until the driver checks the box. */}
        <Card forceDark variant="surface" padding="md" className="mb-4">
          <Pressable
            onPress={() => setTermsAccepted((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: termsAccepted }}
            accessibilityLabel={t('onboarding.accept_terms', {
              defaultValue: 'He leído y acepto los Términos y Condiciones de TriciGo.',
            })}
            hitSlop={8}
            className="flex-row items-start gap-2"
          >
            <Ionicons
              name={termsAccepted ? 'checkbox' : 'square-outline'}
              size={22}
              color={termsAccepted ? midnightEmber.accent[500] : midnightEmber.map.text.tertiary}
              style={{ marginTop: 1 }}
            />
            <View className="flex-1">
              <Text variant="bodySmall" color="inverse">
                {t('onboarding.accept_terms', {
                  defaultValue: 'He leído y acepto los Términos y Condiciones de TriciGo.',
                })}
              </Text>
              <Pressable onPress={() => router.push('/profile/terms')} hitSlop={6}>
                <Text variant="caption" style={{ color: midnightEmber.accent[500], marginTop: 4 }}>
                  {t('onboarding.read_terms', { defaultValue: 'Leer los Términos y Condiciones' })}
                </Text>
              </Pressable>
            </View>
          </Pressable>
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
          disabled={submitting || requiredUploaded < requiredTotal || !driverProfileId || !termsAccepted}
        />
        {/* UX: when Submit is disabled because docs are missing, say so
             explicitly. Previously the button just looked grayed out with
             no explanation — drivers thought the app was broken. */}
        {!submitting && requiredUploaded < requiredTotal && (
          <Text variant="caption" style={{ color: midnightEmber.state.warning, textAlign: 'center', marginTop: 8 }}>
            {t('onboarding.submit_disabled_docs', {
              missing: requiredTotal - requiredUploaded,
              defaultValue: `Falta${requiredTotal - requiredUploaded === 1 ? '' : 'n'} ${requiredTotal - requiredUploaded} documento${requiredTotal - requiredUploaded === 1 ? '' : 's'} por subir.`,
            })}
          </Text>
        )}
        {!submitting && requiredUploaded >= requiredTotal && !termsAccepted && (
          <Text variant="caption" style={{ color: midnightEmber.state.warning, textAlign: 'center', marginTop: 8 }}>
            {t('onboarding.submit_disabled_terms', {
              defaultValue: 'Debes aceptar los Términos y Condiciones para enviar.',
            })}
          </Text>
        )}

        {/* BUG-299: escape hatch — driver can switch accounts at any
            onboarding step. Without this they're trapped after OTP. */}
        <SwitchAccountFooter />
      </View>
    </Screen>
  );
}
