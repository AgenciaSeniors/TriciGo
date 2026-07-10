import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, Alert, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { useDriverStore } from '@/stores/driver.store';
import { PACKAGE_CATEGORIES } from '@tricigo/types';
import { PACKAGE_CATEGORY_LABELS } from '@tricigo/utils';
import type { PackageCategory } from '@tricigo/types';

export default function CargoSettingsScreen() {
  const { t, i18n } = useTranslation('driver');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const driverId = useDriverStore((s) => s.profile?.id);

  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [maxWeight, setMaxWeight] = useState('');
  const [maxLength, setMaxLength] = useState('');
  const [maxWidth, setMaxWidth] = useState('');
  const [maxHeight, setMaxHeight] = useState('');
  const [categories, setCategories] = useState<PackageCategory[]>([]);
  const [saving, setSaving] = useState(false);
  // 'loading' → fetching; 'ready' → vehicle loaded; 'error' → fetch failed
  // (retryable); 'no_vehicle' → driver has no active vehicle to configure.
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'no_vehicle'>('loading');
  const [weightError, setWeightError] = useState('');
  const [categoriesError, setCategoriesError] = useState('');

  const lang = (i18n.language ?? 'es') as 'es' | 'en' | 'pt';

  // Load the current vehicle + cargo settings. Returns the vehicle id (or null).
  // Previously this swallowed a failed getVehicle() and left the form rendered
  // with vehicleId=null, so "Guardar configuración" silently no-op'd
  // (`if (!vehicleId) return`) — on Cuba's flaky connections a single failed GET
  // bricked the screen with no feedback. Now failures surface a retry state.
  const loadVehicle = useCallback(async (): Promise<string | null> => {
    if (!driverId) return null;
    setLoadState('loading');
    try {
      const v = await driverService.getVehicle(driverId);
      if (!v) {
        setLoadState('no_vehicle');
        return null;
      }
      setVehicleId(v.id);
      setMaxWeight(v.max_cargo_weight_kg ? String(v.max_cargo_weight_kg) : '');
      setMaxLength(v.max_cargo_length_cm ? String(v.max_cargo_length_cm) : '');
      setMaxWidth(v.max_cargo_width_cm ? String(v.max_cargo_width_cm) : '');
      setMaxHeight(v.max_cargo_height_cm ? String(v.max_cargo_height_cm) : '');
      setCategories(v.accepted_cargo_categories?.length ? v.accepted_cargo_categories : []);
      setLoadState('ready');
      return v.id;
    } catch {
      setLoadState('error');
      return null;
    }
  }, [driverId]);

  useEffect(() => {
    void loadVehicle();
  }, [loadVehicle]);

  const toggleCategory = useCallback((cat: PackageCategory) => {
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
    setCategoriesError('');
  }, []);

  const handleSave = async () => {
    // If the vehicle never loaded (e.g. a transient fetch failure), retry once
    // here instead of silently doing nothing — otherwise the button looks dead.
    let vId = vehicleId;
    if (!vId) {
      vId = await loadVehicle();
      if (!vId) {
        Alert.alert(
          t('profile.cargo_vehicle_load_failed_title', { defaultValue: 'No se pudo cargar tu vehículo' }),
          t('profile.cargo_vehicle_load_failed_body', {
            defaultValue: 'Revisa tu conexión e inténtalo de nuevo. Si acabas de registrarte, espera la aprobación de tu vehículo.',
          }),
        );
        return;
      }
    }

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
      await driverService.updateVehicleCargo(vId, {
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
    <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4">
        {/* Header */}
        <ProfileScreenHeader
          title={t('profile.cargo_settings_title', { defaultValue: 'Configurar envíos' })}
          onBack={() => router.back()}
        />

        {loadState === 'loading' ? (
          <View className="items-center py-20">
            <Text variant="body" color="primary" className="opacity-50">...</Text>
          </View>
        ) : loadState === 'error' ? (
          <View className="items-center py-16 px-4">
            <Ionicons name="cloud-offline-outline" size={40} color={midnightEmber.state.danger} />
            <Text variant="body" color="primary" className="mt-3 mb-4 text-center">
              {t('profile.cargo_vehicle_load_error', { defaultValue: 'No pudimos cargar tu vehículo. Revisa tu conexión.' })}
            </Text>
            <Button
              title={t('common:retry', { defaultValue: 'Reintentar' })}
              onPress={() => { void loadVehicle(); }}
              size="md"
            />
          </View>
        ) : loadState === 'no_vehicle' ? (
          <View className="items-center py-16 px-4">
            <Ionicons name="car-outline" size={40} color={midnightEmber.screen.text.tertiary} />
            <Text variant="body" color="primary" className="mt-3 text-center">
              {t('profile.cargo_no_vehicle', { defaultValue: 'Necesitas un vehículo activo para configurar envíos.' })}
            </Text>
          </View>
        ) : (
          <>
            {/* Max weight */}
            <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
              <View className="flex-row items-center mb-3">
                <Ionicons name="scale-outline" size={20} color={midnightEmber.accent[500]} />
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
                <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="mt-1">{weightError}</Text>
              ) : null}
            </Card>

            {/* Dimensions */}
            <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
              <View className="flex-row items-center mb-3">
                <Ionicons name="cube-outline" size={20} color={midnightEmber.accent[500]} />
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
                <Ionicons name="pricetags-outline" size={20} color={midnightEmber.accent[500]} />
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
                      className="px-4 py-2 rounded-full border"
                      style={{
                        borderColor: selected ? midnightEmber.accent[500] : midnightEmber.screen.line.default,
                        backgroundColor: selected ? `${midnightEmber.accent[500]}1A` : 'transparent',
                      }}
                    >
                      <Text
                        variant="bodySmall"
                        style={{ color: selected ? midnightEmber.accent[500] : midnightEmber.screen.text.tertiary }}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {categoriesError ? (
                <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="mt-2">{categoriesError}</Text>
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
      </View>
    </Screen>
  );
}
