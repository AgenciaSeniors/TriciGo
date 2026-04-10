import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { useDriverStore } from '@/stores/driver.store';
import { PACKAGE_CATEGORIES } from '@tricigo/types';
import { PACKAGE_CATEGORY_LABELS } from '@tricigo/utils';
import type { PackageCategory } from '@tricigo/types';

export default function CargoSettingsScreen() {
  const { t, i18n } = useTranslation('driver');
  const driverId = useDriverStore((s) => s.profile?.id);

  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [maxWeight, setMaxWeight] = useState('');
  const [maxLength, setMaxLength] = useState('');
  const [maxWidth, setMaxWidth] = useState('');
  const [maxHeight, setMaxHeight] = useState('');
  const [categories, setCategories] = useState<PackageCategory[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [weightError, setWeightError] = useState('');
  const [categoriesError, setCategoriesError] = useState('');

  const lang = (i18n.language ?? 'es') as 'es' | 'en' | 'pt';

  // Load current vehicle cargo settings
  useEffect(() => {
    if (!driverId) return;
    driverService.getVehicle(driverId).then((v) => {
      if (v) {
        setVehicleId(v.id);
        if (v.max_cargo_weight_kg) setMaxWeight(String(v.max_cargo_weight_kg));
        if (v.max_cargo_length_cm) setMaxLength(String(v.max_cargo_length_cm));
        if (v.max_cargo_width_cm) setMaxWidth(String(v.max_cargo_width_cm));
        if (v.max_cargo_height_cm) setMaxHeight(String(v.max_cargo_height_cm));
        if (v.accepted_cargo_categories?.length) setCategories(v.accepted_cargo_categories);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [driverId]);

  const toggleCategory = useCallback((cat: PackageCategory) => {
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
    setCategoriesError('');
  }, []);

  const handleSave = async () => {
    if (!vehicleId) return;

    // Validate
    const weight = parseFloat(maxWeight);
    if (!maxWeight || isNaN(weight) || weight <= 0) {
      setWeightError(t('onboarding.error_cargo_weight_required', { defaultValue: 'Ingrese el peso máximo' }));
      return;
    }
    if (categories.length === 0) {
      setCategoriesError(t('onboarding.error_cargo_categories_required', { defaultValue: 'Seleccione al menos una categoría' }));
      return;
    }

    setSaving(true);
    try {
      await driverService.updateVehicleCargo(vehicleId, {
        accepts_cargo: true,
        max_cargo_weight_kg: weight,
        max_cargo_length_cm: maxLength ? parseInt(maxLength, 10) : null,
        max_cargo_width_cm: maxWidth ? parseInt(maxWidth, 10) : null,
        max_cargo_height_cm: maxHeight ? parseInt(maxHeight, 10) : null,
        accepted_cargo_categories: categories,
      });
      router.back();
    } catch {
      Alert.alert('Error', t('errors.generic', { ns: 'common' }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll bg="lightPrimary" statusBarStyle="dark-content" padded>
      <View className="pt-4">
        {/* Header */}
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#0F172A" />
          </Pressable>
          <Text variant="h3" color="primary">
            {t('profile.cargo_settings_title', { defaultValue: 'Configurar envíos' })}
          </Text>
        </View>

        {loading ? (
          <View className="items-center py-20">
            <Text variant="body" color="primary" className="opacity-50">...</Text>
          </View>
        ) : (
          <>
            {/* Max weight */}
            <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
              <View className="flex-row items-center mb-3">
                <Ionicons name="scale-outline" size={20} color={colors.brand.orange} />
                <Text variant="body" color="primary" className="ml-2 font-semibold">
                  {t('onboarding.max_cargo_weight', { defaultValue: 'Peso máximo de carga (kg)' })}
                </Text>
              </View>
              <Input
                value={maxWeight}
                onChangeText={(v) => { setMaxWeight(v); setWeightError(''); }}
                keyboardType="numeric"
                placeholder="100"
                variant="light"
              />
              {weightError ? (
                <Text variant="caption" className="text-red-400 mt-1">{weightError}</Text>
              ) : null}
            </Card>

            {/* Dimensions */}
            <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
              <View className="flex-row items-center mb-3">
                <Ionicons name="cube-outline" size={20} color={colors.brand.orange} />
                <Text variant="body" color="primary" className="ml-2 font-semibold">
                  {t('onboarding.cargo_dimensions', { defaultValue: 'Dimensiones máx. carga (cm)' })}
                </Text>
              </View>
              <Text variant="caption" color="primary" className="opacity-40 mb-2">
                {t('profile.dimensions_optional', { defaultValue: 'Opcional — ayuda a asignar envíos compatibles' })}
              </Text>
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <Input
                    value={maxLength}
                    onChangeText={setMaxLength}
                    keyboardType="numeric"
                    placeholder="L (cm)"
                    variant="light"
                  />
                </View>
                <View className="flex-1">
                  <Input
                    value={maxWidth}
                    onChangeText={setMaxWidth}
                    keyboardType="numeric"
                    placeholder="A (cm)"
                    variant="light"
                  />
                </View>
                <View className="flex-1">
                  <Input
                    value={maxHeight}
                    onChangeText={setMaxHeight}
                    keyboardType="numeric"
                    placeholder="H (cm)"
                    variant="light"
                  />
                </View>
              </View>
            </Card>

            {/* Categories */}
            <Card theme="light" variant="filled" padding="md" className="mb-6 bg-white">
              <View className="flex-row items-center mb-3">
                <Ionicons name="pricetags-outline" size={20} color={colors.brand.orange} />
                <Text variant="body" color="primary" className="ml-2 font-semibold">
                  {t('onboarding.cargo_categories', { defaultValue: 'Categorías de carga aceptadas' })}
                </Text>
              </View>
              <View className="flex-row flex-wrap gap-2">
                {PACKAGE_CATEGORIES.map((cat) => {
                  const selected = categories.includes(cat);
                  const label = PACKAGE_CATEGORY_LABELS[cat]?.[lang] ?? cat;
                  return (
                    <Pressable
                      key={cat}
                      onPress={() => toggleCategory(cat)}
                      className={`px-4 py-2 rounded-full border ${
                        selected
                          ? 'border-primary-500 bg-primary-500/10'
                          : 'border-neutral-600 bg-transparent'
                      }`}
                    >
                      <Text
                        variant="bodySmall"
                        className={selected ? 'text-primary-500' : 'text-neutral-400'}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {categoriesError ? (
                <Text variant="caption" className="text-red-400 mt-2">{categoriesError}</Text>
              ) : null}
            </Card>

            {/* Save */}
            <Button
              title={t('profile.cargo_save', { defaultValue: 'Guardar configuración' })}
              onPress={handleSave}
              loading={saving}
              fullWidth
              size="lg"
            />
          </>
        )}
      </View>
    </Screen>
  );
}
