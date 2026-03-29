import React, { useState } from 'react';
import { View, Pressable, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { useOnboardingStore } from '@/stores/onboarding.store';
import { isValidPlateNumber, sanitizeText, PACKAGE_CATEGORY_LABELS } from '@tricigo/utils';
import type { VehicleType, PackageCategory } from '@tricigo/types';
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

const VEHICLE_TYPES: { value: VehicleType; label: string; icon: string; defaultCapacity: number }[] = [
  { value: 'triciclo', label: 'Triciclo', icon: 'bicycle', defaultCapacity: 3 },
  { value: 'moto', label: 'Moto', icon: 'speedometer', defaultCapacity: 1 },
  { value: 'auto', label: 'Auto', icon: 'car', defaultCapacity: 4 },
];

export default function VehicleInfoScreen() {
  const { t } = useTranslation('driver');
  const STEPS = useSteps();
  const { vehicle, setVehicle } = useOnboardingStore();

  const [vehicleType, setVehicleType] = useState<VehicleType | null>(vehicle.type);
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
    if (!isValidPlateNumber(plateNumber.trim().toUpperCase())) e.plate = t('onboarding.error_plate_invalid');
    const c = parseInt(capacity, 10);
    const maxCap = vehicleType === 'moto' ? 1 : vehicleType === 'triciclo' ? 8 : 4;
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
                color={vehicleType === vt.value ? colors.brand.orange : '#737373'}
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
        <Input
          label={t('onboarding.vehicle_capacity', { defaultValue: 'Capacidad de pasajeros' })}
          placeholder={vehicleType === 'moto' ? '1' : vehicleType === 'triciclo' ? '2-8' : '4'}
          keyboardType="number-pad"
          value={capacity}
          onChangeText={setCapacity}
          error={errors.capacity}
          editable={vehicleType !== 'moto'}
        />

        {/* Cargo toggle — all vehicle types */}
        {vehicleType && (
          <View className="mb-4">
            <View className="flex-row items-center justify-between py-3 px-4 bg-neutral-50 rounded-xl">
              <View className="flex-1">
                <Text variant="label">
                  {t('onboarding.accepts_cargo', { defaultValue: 'Acepta carga / delivery' })}
                </Text>
                <Text variant="caption" color="secondary">
                  {t('onboarding.cargo_description', { defaultValue: 'Activar si su vehículo puede transportar mercancía' })}
                </Text>
              </View>
              <Switch
                value={acceptsCargo}
                onValueChange={setAcceptsCargo}
                trackColor={{ false: '#d4d4d4', true: colors.brand.orange }}
                thumbColor="white"
              />
            </View>
            {acceptsCargo && (
              <View className="mt-3">
                <Input
                  label={t('onboarding.max_cargo_weight', { defaultValue: 'Peso máximo de carga (kg)' })}
                  placeholder="100"
                  keyboardType="numeric"
                  value={maxCargoWeight}
                  onChangeText={setMaxCargoWeight}
                  error={errors.cargo_weight}
                />

                <Text variant="label" className="mb-2 mt-2">
                  {t('onboarding.cargo_dimensions', { defaultValue: 'Dimensiones máximas (cm) — opcional' })}
                </Text>
                <View className="flex-row gap-2 mb-4">
                  <View className="flex-1">
                    <Input
                      label={t('onboarding.cargo_length', { defaultValue: 'Largo' })}
                      placeholder="120"
                      keyboardType="numeric"
                      value={maxCargoLength}
                      onChangeText={setMaxCargoLength}
                    />
                  </View>
                  <View className="flex-1">
                    <Input
                      label={t('onboarding.cargo_width', { defaultValue: 'Ancho' })}
                      placeholder="80"
                      keyboardType="numeric"
                      value={maxCargoWidth}
                      onChangeText={setMaxCargoWidth}
                    />
                  </View>
                  <View className="flex-1">
                    <Input
                      label={t('onboarding.cargo_height', { defaultValue: 'Alto' })}
                      placeholder="60"
                      keyboardType="numeric"
                      value={maxCargoHeight}
                      onChangeText={setMaxCargoHeight}
                    />
                  </View>
                </View>

                <Text variant="label" className="mb-2">
                  {t('onboarding.cargo_categories', { defaultValue: 'Categorías aceptadas' })}
                </Text>
                <View className="flex-row flex-wrap gap-2 mb-2">
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
                        className={`px-4 py-2 rounded-full border ${
                          selected
                            ? 'border-primary-500 bg-primary-50'
                            : 'border-neutral-200 bg-white'
                        }`}
                      >
                        <Text
                          variant="bodySmall"
                          color={selected ? 'accent' : 'secondary'}
                        >
                          {PACKAGE_CATEGORY_LABELS[cat]?.es ?? cat}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {errors.cargo_categories ? (
                  <Text variant="caption" color="error" className="mb-2">{errors.cargo_categories}</Text>
                ) : null}
              </View>
            )}
          </View>
        )}

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
