import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { useTranslation } from '@tricigo/i18n';
import { useOnboardingStore } from '@/stores/onboarding.store';
import { isValidPlateNumber, sanitizeText } from '@tricigo/utils';
import type { VehicleType } from '@tricigo/types';

const STEPS = [
  { key: 'personal', label: 'Personal' },
  { key: 'vehicle', label: 'Vehículo' },
  { key: 'documents', label: 'Docs' },
  { key: 'review', label: 'Revisión' },
];

const VEHICLE_TYPES: { value: VehicleType; label: string; icon: string; defaultCapacity: number }[] = [
  { value: 'triciclo', label: 'Triciclo', icon: 'bicycle', defaultCapacity: 3 },
  { value: 'moto', label: 'Moto', icon: 'speedometer', defaultCapacity: 1 },
  { value: 'auto', label: 'Auto', icon: 'car', defaultCapacity: 4 },
];

export default function VehicleInfoScreen() {
  const { t } = useTranslation('driver');
  const { vehicle, setVehicle } = useOnboardingStore();

  const [vehicleType, setVehicleType] = useState<VehicleType | null>(vehicle.type);
  const [make, setMake] = useState(vehicle.make);
  const [model, setModel] = useState(vehicle.model);
  const [year, setYear] = useState(vehicle.year);
  const [color, setColor] = useState(vehicle.color);
  const [plateNumber, setPlateNumber] = useState(vehicle.plate_number);
  const [capacity, setCapacity] = useState(vehicle.capacity);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleTypeSelect = (vt: typeof VEHICLE_TYPES[number]) => {
    setVehicleType(vt.value);
    if (!capacity || capacity === '0') {
      setCapacity(String(vt.defaultCapacity));
    }
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!vehicleType) e.type = t('onboarding.error_vehicle_type_required');
    if (!sanitizeText(make)) e.make = t('onboarding.error_make_required');
    if (!sanitizeText(model)) e.model = t('onboarding.error_model_required');
    const y = parseInt(year, 10);
    if (!y || y < 1990 || y > new Date().getFullYear()) e.year = t('onboarding.error_year_invalid');
    if (!sanitizeText(color)) e.color = t('onboarding.error_color_required');
    if (!isValidPlateNumber(plateNumber.toUpperCase())) e.plate = t('onboarding.error_plate_invalid');
    const c = parseInt(capacity, 10);
    if (!c || c < 1 || c > 10) e.capacity = t('onboarding.error_capacity_invalid');
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleNext = () => {
    if (!validate()) return;
    setVehicle({
      type: vehicleType,
      make: sanitizeText(make),
      model: sanitizeText(model),
      year,
      color: sanitizeText(color),
      plate_number: plateNumber.toUpperCase(),
      capacity,
    });
    router.push('/onboarding/documents');
  };

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <StatusStepper steps={STEPS} currentStep="vehicle" className="mb-6" />

        <Text variant="h3" className="mb-1">
          {t('onboarding.step_vehicle')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          {t('onboarding.step_n_of_total', { step: 2, total: 4 })}
        </Text>

        <Text variant="label" className="mb-2">{t('onboarding.vehicle_type')}</Text>
        <View className="flex-row gap-3 mb-4">
          {VEHICLE_TYPES.map((vt) => (
            <Pressable
              key={vt.value}
              onPress={() => handleTypeSelect(vt)}
              className={`flex-1 items-center p-4 rounded-xl border-2 ${
                vehicleType === vt.value
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-neutral-200 bg-white'
              }`}
            >
              <Ionicons
                name={vt.icon as any}
                size={28}
                color={vehicleType === vt.value ? '#FF4D00' : '#737373'}
              />
              <Text
                variant="label"
                color={vehicleType === vt.value ? 'accent' : 'secondary'}
                className="mt-1"
              >
                {vt.label}
              </Text>
            </Pressable>
          ))}
        </View>
        {errors.type ? (
          <Text variant="caption" color="error" className="mb-2 -mt-2">{errors.type}</Text>
        ) : null}

        <Input label={t('onboarding.vehicle_make')} placeholder="Custom" value={make} onChangeText={setMake} error={errors.make} />
        <Input label={t('onboarding.vehicle_model')} placeholder="Triciclo Eléctrico" value={model} onChangeText={setModel} error={errors.model} />
        <Input label={t('onboarding.vehicle_year')} placeholder="2024" keyboardType="number-pad" value={year} onChangeText={setYear} error={errors.year} />
        <Input label={t('onboarding.vehicle_color')} placeholder="Azul" value={color} onChangeText={setColor} error={errors.color} />
        <Input label={t('onboarding.plate_number')} placeholder="P123456" autoCapitalize="characters" value={plateNumber} onChangeText={setPlateNumber} error={errors.plate} />
        <Input label={t('onboarding.vehicle_capacity')} placeholder="3" keyboardType="number-pad" value={capacity} onChangeText={setCapacity} error={errors.capacity} />

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
