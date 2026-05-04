/**
 * Driver matching preferences screen — equivalente por rol al
 * `apps/client/app/profile/ride-preferences.tsx` del rider.
 *
 * Persiste en `driver_profiles.preferences` JSONB (migración 00257).
 * Estos campos afectan el matching engine: el dispatch los lee al
 * generar ride_offers para filtrar/scorear ofertas que NO calzan con
 * las preferencias del driver.
 *
 * Diferencia con cargo-settings.tsx: cargo-settings vive en `vehicles`
 * y describe CAPACIDAD del vehículo. Esta pantalla son PREFERENCIAS
 * personales del conductor.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, Switch, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { triggerHaptic } from '@tricigo/utils';
import Toast from 'react-native-toast-message';
import { useDriverStore } from '@/stores/driver.store';
import type { DriverPreferences } from '@tricigo/types';

const DEFAULT_PREFS: Required<DriverPreferences> = {
  max_distance_km: 30,
  accepts_long_trips: true,
  music_preference: 'low',
  accepts_minors_alone: true,
};

// NonNullable porque `DriverPreferences['music_preference']` es opcional
// pero estos literales del UI nunca son undefined.
const MUSIC_OPTIONS: { value: NonNullable<DriverPreferences['music_preference']>; label: string }[] = [
  { value: 'none', label: 'Sin música' },
  { value: 'low', label: 'Bajo / radio' },
  { value: 'any', label: 'Cualquiera' },
];

export default function DriverPreferencesScreen() {
  const { t } = useTranslation('common');
  const profile = useDriverStore((s) => s.profile);
  const setProfile = useDriverStore((s) => s.setProfile);
  const driverId = profile?.id ?? null;

  const [prefs, setPrefs] = useState<Required<DriverPreferences>>({ ...DEFAULT_PREFS });
  const [maxDistanceText, setMaxDistanceText] = useState(String(DEFAULT_PREFS.max_distance_km));
  const [saving, setSaving] = useState(false);

  // Hydrate from store on mount.
  useEffect(() => {
    if (!profile?.preferences) return;
    const merged: Required<DriverPreferences> = { ...DEFAULT_PREFS, ...profile.preferences };
    setPrefs(merged);
    setMaxDistanceText(String(merged.max_distance_km));
  }, [profile?.preferences]);

  const handleSave = useCallback(async () => {
    if (!driverId) return;
    const parsed = parseInt(maxDistanceText, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
      triggerHaptic('warning');
      Alert.alert(
        t('error', { defaultValue: 'Error' }),
        t('preferences.distance_invalid', {
          defaultValue: 'La distancia máxima debe estar entre 1 y 200 km',
        }),
      );
      return;
    }
    setSaving(true);
    try {
      const updated: DriverPreferences = { ...prefs, max_distance_km: parsed };
      await driverService.updatePreferences(driverId, updated);
      // Mirror to local store so other screens reading `profile.preferences`
      // ven el cambio sin re-fetch.
      if (profile) {
        setProfile({ ...profile, preferences: updated });
      }
      triggerHaptic('success');
      Toast.show({
        type: 'success',
        text1: t('preferences.saved', { defaultValue: 'Preferencias guardadas' }),
      });
      router.back();
    } catch {
      triggerHaptic('warning');
      Alert.alert(
        t('error', { defaultValue: 'Error' }),
        t('errors.generic', { defaultValue: 'Algo salió mal. Intentá de nuevo.' }),
      );
    } finally {
      setSaving(false);
    }
  }, [driverId, maxDistanceText, prefs, profile, setProfile, t]);

  return (
    <Screen scroll bg="lightPrimary" statusBarStyle="dark-content" padded>
      <View className="pt-4">
        {/* Header */}
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            className="mr-3 w-10 h-10 rounded-xl bg-[#F1F5F9] items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('back', { defaultValue: 'Volver' })}
          >
            <Ionicons name="arrow-back" size={20} color="#0F172A" />
          </Pressable>
          <Text variant="h3" color="primary">
            {t('preferences.driver_title', { defaultValue: 'Preferencias de viaje' })}
          </Text>
        </View>

        <Text variant="bodySmall" color="primary" className="mb-4 opacity-60">
          {t('preferences.driver_desc', {
            defaultValue: 'Estas preferencias se usan para filtrar las ofertas de viaje que recibís.',
          })}
        </Text>

        {/* Max distance */}
        <Card theme="light" variant="filled" padding="md" className="mb-3 bg-white">
          <Text variant="body" color="primary" className="font-semibold mb-1">
            {t('preferences.max_distance', { defaultValue: 'Distancia máxima al pickup' })}
          </Text>
          <Text variant="caption" color="primary" className="opacity-60 mb-3">
            {t('preferences.max_distance_hint', {
              defaultValue: 'No recibirás ofertas donde el pasajero esté a más de esta distancia.',
            })}
          </Text>
          <Input
            value={maxDistanceText}
            onChangeText={(v) => setMaxDistanceText(v.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            placeholder="30"
            variant="light"
            accessibilityLabel={t('preferences.max_distance', { defaultValue: 'Distancia máxima en km' })}
          />
          <Text variant="caption" color="primary" className="opacity-50 mt-1">km</Text>
        </Card>

        {/* Long trips */}
        <Card theme="light" variant="filled" padding="md" className="mb-3 bg-white">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-3">
              <Text variant="body" color="primary" className="font-semibold">
                {t('preferences.accepts_long_trips', { defaultValue: 'Acepto viajes largos' })}
              </Text>
              <Text variant="caption" color="primary" className="opacity-60 mt-0.5">
                {t('preferences.accepts_long_trips_hint', {
                  defaultValue: 'Viajes mayores a 10 km, incluso a otras provincias.',
                })}
              </Text>
            </View>
            <Switch
              value={prefs.accepts_long_trips}
              onValueChange={(v) => setPrefs({ ...prefs, accepts_long_trips: v })}
              trackColor={{ false: '#E2E8F0', true: colors.brand.orange }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Card>

        {/* Music preference */}
        <Card theme="light" variant="filled" padding="md" className="mb-3 bg-white">
          <Text variant="body" color="primary" className="font-semibold mb-1">
            {t('preferences.music', { defaultValue: 'Tolerancia a música del rider' })}
          </Text>
          <Text variant="caption" color="primary" className="opacity-60 mb-3">
            {t('preferences.music_hint', {
              defaultValue: 'Cuánto tolerás que el rider escuche música durante el viaje.',
            })}
          </Text>
          <View className="flex-row gap-2">
            {MUSIC_OPTIONS.map((opt) => {
              const active = prefs.music_preference === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => setPrefs({ ...prefs, music_preference: opt.value })}
                  className={`flex-1 py-2.5 rounded-xl border ${active ? 'border-orange-500 bg-orange-50' : 'border-neutral-200 bg-neutral-50'}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                >
                  <Text
                    variant="caption"
                    className={`text-center font-medium ${active ? 'text-orange-600' : 'text-neutral-600'}`}
                  >
                    {t(`preferences.music_${opt.value}`, { defaultValue: opt.label })}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Card>

        {/* Minors alone */}
        <Card theme="light" variant="filled" padding="md" className="mb-6 bg-white">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-3">
              <Text variant="body" color="primary" className="font-semibold">
                {t('preferences.accepts_minors_alone', {
                  defaultValue: 'Acepto menores sin adulto',
                })}
              </Text>
              <Text variant="caption" color="primary" className="opacity-60 mt-0.5">
                {t('preferences.accepts_minors_alone_hint', {
                  defaultValue: 'Riders menores de edad viajando sin un adulto acompañante.',
                })}
              </Text>
            </View>
            <Switch
              value={prefs.accepts_minors_alone}
              onValueChange={(v) => setPrefs({ ...prefs, accepts_minors_alone: v })}
              trackColor={{ false: '#E2E8F0', true: colors.brand.orange }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Card>

        {/* Save */}
        <Button
          title={t('save', { defaultValue: 'Guardar' })}
          onPress={handleSave}
          loading={saving}
          fullWidth
          size="lg"
        />
      </View>
    </Screen>
  );
}
