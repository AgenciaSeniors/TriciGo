import React, { useState } from 'react';
import { View, Pressable, Switch, Image, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { useOnboardingStore } from '@/stores/onboarding.store';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import { isValidPlateNumber, sanitizeText, PACKAGE_CATEGORY_LABELS } from '@tricigo/utils';
import type { VehicleType, PackageCategory, ServiceTypeSlug } from '@tricigo/types';
import { PACKAGE_CATEGORIES } from '@tricigo/types';

function useSteps() {
  const { t } = useTranslation('driver');
  return [
    { key: 'personal', label: t('onboarding.step_personal', { defaultValue: 'Personal' }) },
    { key: 'vehicle', label: t('onboarding.step_vehicle', { defaultValue: 'Vehículo' }) },
    { key: 'documents', label: t('onboarding.step_docs', { defaultValue: 'Docs' }) },
    { key: 'review', label: t('onboarding.step_review', { defaultValue: 'Revisión' }) },
  ];
}

// Vehicle type configurations with images and metadata
const VEHICLE_CONFIGS = [
  {
    vehicleType: 'triciclo' as VehicleType,
    serviceSlug: 'triciclo_basico' as ServiceTypeSlug,
    labelKey: 'onboarding.triciclo',
    descKey: 'onboarding.vehicle_triciclo_desc',
    defaultCapacity: 3,
    maxCapacity: 8,
    image: require('../../assets/vehicles/selection/triciclo.png'),
    accent: '#F97316',
  },
  {
    vehicleType: 'moto' as VehicleType,
    serviceSlug: 'moto_standard' as ServiceTypeSlug,
    labelKey: 'onboarding.moto',
    descKey: 'onboarding.vehicle_moto_desc',
    defaultCapacity: 1,
    maxCapacity: 1,
    image: require('../../assets/vehicles/selection/moto.png'),
    accent: '#3B82F6',
  },
  {
    vehicleType: 'auto' as VehicleType,
    serviceSlug: 'auto_standard' as ServiceTypeSlug,
    labelKey: 'onboarding.auto',
    descKey: 'onboarding.vehicle_auto_desc',
    defaultCapacity: 4,
    maxCapacity: 16,
    image: require('../../assets/vehicles/selection/auto.png'),
    accent: '#22C55E',
  },
  {
    vehicleType: 'auto' as VehicleType,
    serviceSlug: 'auto_confort' as ServiceTypeSlug,
    labelKey: 'onboarding.vehicle_confort',
    descKey: 'onboarding.vehicle_confort_desc',
    defaultCapacity: 4,
    maxCapacity: 16,
    image: require('../../assets/vehicles/selection/confort.png'),
    accent: '#A855F7',
  },
];

export default function VehicleInfoScreen() {
  const { t } = useTranslation('driver');
  const STEPS = useSteps();
  const { isPhone } = useResponsive();
  const { vehicle, setVehicle } = useOnboardingStore();

  // Use serviceSlug to distinguish auto vs confort
  const [selectedSlug, setSelectedSlug] = useState<ServiceTypeSlug | null>(
    vehicle.type === 'auto' ? (vehicle.service_type_slug || 'auto_standard') : vehicle.type ? `${vehicle.type === 'triciclo' ? 'triciclo_basico' : vehicle.type === 'moto' ? 'moto_standard' : 'auto_standard'}` as ServiceTypeSlug : null,
  );
  const selectedConfig = VEHICLE_CONFIGS.find((c) => c.serviceSlug === selectedSlug) || null;
  const vehicleType = selectedConfig?.vehicleType || null;

  const [make, setMake] = useState(vehicle.make);
  const [model, setModel] = useState(vehicle.model);
  const [year, setYear] = useState(vehicle.year);
  const [color, setColor] = useState(vehicle.color);
  const [plateNumber, setPlateNumber] = useState(vehicle.plate_number);
  const [capacity, setCapacity] = useState(vehicle.capacity);
  const [acceptsCargo, setAcceptsCargo] = useState(vehicle.accepts_cargo);
  const [maxCargoWeight, setMaxCargoWeight] = useState(vehicle.max_cargo_weight_kg);
  const [maxCargoLength, setMaxCargoLength] = useState(vehicle.max_cargo_length_cm);
  const [maxCargoWidth, setMaxCargoWidth] = useState(vehicle.max_cargo_width_cm);
  const [maxCargoHeight, setMaxCargoHeight] = useState(vehicle.max_cargo_height_cm);
  const [acceptedCategories, setAcceptedCategories] = useState<PackageCategory[]>(vehicle.accepted_cargo_categories);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleTypeSelect = (config: typeof VEHICLE_CONFIGS[number]) => {
    setSelectedSlug(config.serviceSlug);
    if (!capacity || capacity === '0') {
      setCapacity(String(config.defaultCapacity));
    }
    // Moto always 1 passenger
    if (config.vehicleType === 'moto') {
      setCapacity('1');
    }
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!selectedSlug) e.type = t('onboarding.error_vehicle_type_required');
    if (!sanitizeText(make)) e.make = t('onboarding.error_make_required');
    if (!sanitizeText(model)) e.model = t('onboarding.error_model_required');
    const y = parseInt(year, 10);
    if (!y || y < 1990 || y > new Date().getFullYear()) e.year = t('onboarding.error_year_invalid');
    if (!sanitizeText(color)) e.color = t('onboarding.error_color_required');
    if (!isValidPlateNumber(plateNumber.trim().toUpperCase())) e.plate = t('onboarding.error_plate_invalid');
    const c = parseInt(capacity, 10);
    const maxCap = selectedConfig?.maxCapacity || 4;
    if (!c || c < 1 || c > maxCap) e.capacity = t('onboarding.error_capacity_invalid');
    if (acceptsCargo) {
      if (!maxCargoWeight || parseFloat(maxCargoWeight) <= 0 || isNaN(parseFloat(maxCargoWeight))) {
        e.cargo_weight = t('onboarding.error_cargo_weight_required', { defaultValue: 'Ingrese el peso máximo de carga' });
      }
      if (acceptedCategories.length === 0) {
        e.cargo_categories = t('onboarding.error_cargo_categories_required', { defaultValue: 'Seleccione al menos una categoría' });
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleNext = () => {
    if (!validate()) return;
    setVehicle({
      type: vehicleType,
      service_type_slug: selectedSlug || undefined,
      make: sanitizeText(make),
      model: sanitizeText(model),
      year,
      color: sanitizeText(color),
      plate_number: plateNumber.toUpperCase(),
      capacity,
      accepts_cargo: acceptsCargo,
      max_cargo_weight_kg: acceptsCargo ? maxCargoWeight : '',
      max_cargo_length_cm: acceptsCargo ? maxCargoLength : '',
      max_cargo_width_cm: acceptsCargo ? maxCargoWidth : '',
      max_cargo_height_cm: acceptsCargo ? maxCargoHeight : '',
      accepted_cargo_categories: acceptsCargo ? acceptedCategories : [],
    });
    router.push('/onboarding/documents');
  };

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header gradient */}
          <LinearGradient
            colors={['#1A1A1A', '#111111']}
            style={{ paddingTop: 12, paddingBottom: 20, paddingHorizontal: 20 }}
          >
            <View style={!isPhone ? { maxWidth: 480, width: '100%', alignSelf: 'center' } : undefined}>
              <StatusStepper steps={STEPS} currentStep="vehicle" variant="dark" className="mb-4" />
            </View>
          </LinearGradient>

          {/* Orange accent line */}
          <LinearGradient
            colors={['#FF4D00', '#FF6B2C']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ height: 3 }}
          />

          <View
            className="px-5 pt-6"
            style={!isPhone ? { maxWidth: 480, width: '100%', alignSelf: 'center' } : undefined}
          >
            {/* ─── Section: Vehicle Type ─── */}
            <AnimatedCard delay={0} duration={400}>
              <View className="flex-row items-center mb-5">
                <View className="w-10 h-10 rounded-full bg-[#252540] items-center justify-center mr-3">
                  <Ionicons name="car-sport" size={20} color={colors.brand.orange} />
                </View>
                <View>
                  <Text variant="h3" color="inverse">
                    {t('onboarding.vehicle_type')}
                  </Text>
                  <Text variant="caption" color="secondary">
                    {t('onboarding.step_n_of_total', { step: 2, total: 4 })}
                  </Text>
                </View>
              </View>
            </AnimatedCard>

            {/* Vehicle type cards — 2x2 grid */}
            <AnimatedCard delay={100} duration={400}>
              <View className="flex-row flex-wrap gap-3 mb-5">
                {VEHICLE_CONFIGS.map((config) => {
                  const isSelected = selectedSlug === config.serviceSlug;
                  return (
                    <Pressable
                      key={config.serviceSlug}
                      onPress={() => handleTypeSelect(config)}
                      style={{
                        width: '47.5%',
                        borderWidth: 2,
                        borderColor: isSelected ? config.accent : '#252540',
                        borderRadius: 16,
                        backgroundColor: isSelected ? `${config.accent}15` : '#1a1a2e',
                        padding: 16,
                        alignItems: 'center',
                      }}
                    >
                      <Image
                        source={config.image}
                        style={{ width: 72, height: 72, marginBottom: 8 }}
                        resizeMode="contain"
                      />
                      <Text
                        variant="body"
                        style={{ color: isSelected ? config.accent : '#FFFFFF', fontWeight: '700', textAlign: 'center' }}
                      >
                        {t(config.labelKey, { defaultValue: config.labelKey })}
                      </Text>
                      {isSelected && (
                        <View style={{ position: 'absolute', top: 8, right: 8 }}>
                          <Ionicons name="checkmark-circle" size={20} color={config.accent} />
                        </View>
                      )}
                    </Pressable>
                  );
                })}
              </View>
              {errors.type ? (
                <Text variant="caption" color="error" className="mb-3 -mt-2">{errors.type}</Text>
              ) : null}
            </AnimatedCard>

            {/* ─── Section: Vehicle Details ─── */}
            {selectedSlug && (
              <>
                <AnimatedCard delay={200} duration={400}>
                  <View className="flex-row items-center mb-4">
                    <View className="w-10 h-10 rounded-full bg-blue-500/20 items-center justify-center mr-3">
                      <Ionicons name="information-circle" size={20} color="#3B82F6" />
                    </View>
                    <Text variant="h3" color="inverse">
                      {t('onboarding.step_vehicle', { defaultValue: 'Detalles del vehículo' })}
                    </Text>
                  </View>
                </AnimatedCard>

                <AnimatedCard delay={300} duration={400}>
                  <Card forceDark variant="filled" padding="lg" className="bg-neutral-900 mb-5">
                    <Input label={t('onboarding.vehicle_make')} placeholder="Custom" value={make} onChangeText={setMake} error={errors.make} variant="dark" />
                    <Input label={t('onboarding.vehicle_model')} placeholder="Triciclo Eléctrico" value={model} onChangeText={setModel} error={errors.model} variant="dark" />
                    <View className="flex-row gap-3">
                      <View className="flex-1">
                        <Input label={t('onboarding.vehicle_year')} placeholder="2024" keyboardType="number-pad" value={year} onChangeText={setYear} error={errors.year} variant="dark" />
                      </View>
                      <View className="flex-1">
                        <Input label={t('onboarding.vehicle_color')} placeholder="Azul" value={color} onChangeText={setColor} error={errors.color} variant="dark" />
                      </View>
                    </View>
                    <Input label={t('onboarding.plate_number')} placeholder="P123456" autoCapitalize="characters" value={plateNumber} onChangeText={setPlateNumber} error={errors.plate} variant="dark" />

                    {/* Capacity + Passengers */}
                    <View className="flex-row items-center gap-3">
                      <View className="flex-1">
                        <Input
                          label={t('onboarding.max_passengers')}
                          placeholder={String(selectedConfig?.defaultCapacity || 4)}
                          keyboardType="number-pad"
                          value={capacity}
                          onChangeText={setCapacity}
                          error={errors.capacity}
                          editable={vehicleType !== 'moto'}
                          variant="dark"
                        />
                      </View>
                      <View className="items-center pt-4">
                        <Ionicons name="people" size={24} color="#9CA3AF" />
                      </View>
                    </View>
                  </Card>
                </AnimatedCard>

                {/* ─── Section: Cargo / Delivery ─── */}
                <AnimatedCard delay={400} duration={400}>
                  <Card forceDark variant="surface" padding="lg" className="mb-5">
                    <View className="flex-row items-center justify-between mb-3">
                      <View className="flex-row items-center flex-1">
                        <View className="w-8 h-8 rounded-full bg-[#252540] items-center justify-center mr-2">
                          <Ionicons name="cube" size={16} color={colors.brand.orange} />
                        </View>
                        <View className="flex-1">
                          <Text variant="body" color="inverse" className="font-semibold">
                            {t('onboarding.accepts_deliveries')}
                          </Text>
                        </View>
                      </View>
                      <Switch
                        value={acceptsCargo}
                        onValueChange={setAcceptsCargo}
                        trackColor={{ false: '#252540', true: colors.brand.orange }}
                        thumbColor="#FFFFFF"
                        accessibilityLabel={t('onboarding.accepts_deliveries')}
                      />
                    </View>

                    {acceptsCargo && (
                      <View className="mt-2">
                        <Input
                          label={t('onboarding.max_cargo_weight')}
                          placeholder="100"
                          keyboardType="numeric"
                          value={maxCargoWeight}
                          onChangeText={setMaxCargoWeight}
                          error={errors.cargo_weight}
                          variant="dark"
                        />

                        <Text variant="bodySmall" color="secondary" className="mb-2 mt-1">
                          {t('onboarding.cargo_dimensions')}
                        </Text>
                        <View className="flex-row gap-2 mb-3">
                          <View className="flex-1">
                            <Input placeholder="L (cm)" keyboardType="numeric" value={maxCargoLength} onChangeText={setMaxCargoLength} variant="dark" />
                          </View>
                          <View className="flex-1">
                            <Input placeholder="A (cm)" keyboardType="numeric" value={maxCargoWidth} onChangeText={setMaxCargoWidth} variant="dark" />
                          </View>
                          <View className="flex-1">
                            <Input placeholder="H (cm)" keyboardType="numeric" value={maxCargoHeight} onChangeText={setMaxCargoHeight} variant="dark" />
                          </View>
                        </View>

                        <Text variant="bodySmall" color="secondary" className="mb-2">
                          {t('onboarding.cargo_categories')}
                        </Text>
                        <View className="flex-row flex-wrap gap-2 mb-1">
                          {PACKAGE_CATEGORIES.map((cat) => {
                            const selected = acceptedCategories.includes(cat);
                            return (
                              <Pressable
                                key={cat}
                                onPress={() => {
                                  setAcceptedCategories((prev) =>
                                    selected ? prev.filter((c) => c !== cat) : [...prev, cat],
                                  );
                                }}
                                style={{
                                  paddingHorizontal: 14,
                                  paddingVertical: 8,
                                  borderRadius: 20,
                                  borderWidth: 1,
                                  borderColor: selected ? colors.brand.orange : '#252540',
                                  backgroundColor: selected ? 'rgba(255,77,0,0.15)' : '#1a1a2e',
                                }}
                              >
                                <Text
                                  variant="bodySmall"
                                  style={{ color: selected ? colors.brand.orange : '#9CA3AF' }}
                                >
                                  {PACKAGE_CATEGORY_LABELS[cat]?.es ?? cat}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                        {errors.cargo_categories ? (
                          <Text variant="caption" color="error" className="mt-1">{errors.cargo_categories}</Text>
                        ) : null}
                      </View>
                    )}
                  </Card>
                </AnimatedCard>
              </>
            )}

            {/* ─── Next Button ─── */}
            <AnimatedCard delay={500} duration={400}>
              <Button
                title={t('common:next', { defaultValue: 'Siguiente' })}
                size="lg"
                fullWidth
                onPress={handleNext}
                className="mt-2 mb-8"
              />
            </AnimatedCard>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
