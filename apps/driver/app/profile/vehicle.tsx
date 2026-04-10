import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { useDriverStore } from '@/stores/driver.store';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { Vehicle } from '@tricigo/types';
import { PACKAGE_CATEGORY_LABELS } from '@tricigo/utils';

const VEHICLE_IMAGES: Record<string, any> = {
  triciclo: require('../../assets/vehicles/selection/triciclo.png'),
  moto: require('../../assets/vehicles/selection/moto.png'),
  auto: require('../../assets/vehicles/selection/auto.png'),
};

export default function VehicleScreen() {
  const { t } = useTranslation('common');
  const driverProfile = useDriverStore((s) => s.profile);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchVehicle = useCallback(() => {
    if (!driverProfile) return;
    setLoading(true);
    driverService
      .getVehicle(driverProfile.id)
      .then(setVehicle)
      .catch((err) => setError(err instanceof Error ? err.message : 'Error desconocido'))
      .finally(() => setLoading(false));
  }, [driverProfile]);

  useEffect(() => {
    fetchVehicle();
  }, [fetchVehicle]);

  const infoRows = vehicle
    ? [
        { label: t('vehicle.type', { defaultValue: 'Tipo' }), value: vehicle.type },
        { label: t('vehicle.make', { defaultValue: 'Marca' }), value: vehicle.make },
        { label: t('vehicle.model', { defaultValue: 'Modelo' }), value: vehicle.model },
        { label: t('vehicle.year', { defaultValue: 'Año' }), value: String(vehicle.year) },
        { label: t('vehicle.color', { defaultValue: 'Color' }), value: vehicle.color },
        { label: t('vehicle.plate', { defaultValue: 'Placa' }), value: vehicle.plate_number },
        { label: t('vehicle.capacity', { defaultValue: 'Capacidad' }), value: `${vehicle.capacity} ${t('vehicle.passengers', { defaultValue: 'pasajeros' })}` },
        { label: t('vehicle.accepts_cargo', { defaultValue: 'Acepta carga' }), value: vehicle.accepts_cargo ? `${t('common:yes', { defaultValue: 'Sí' })} — ${vehicle.max_cargo_weight_kg ?? '?'} kg max` : t('common:no', { defaultValue: 'No' }) },
        ...(vehicle.accepts_cargo && (vehicle.max_cargo_length_cm || vehicle.max_cargo_width_cm || vehicle.max_cargo_height_cm)
          ? [{ label: t('vehicle.cargo_dimensions', { defaultValue: 'Dimensiones máx.' }), value: `${vehicle.max_cargo_length_cm ?? '-'} × ${vehicle.max_cargo_width_cm ?? '-'} × ${vehicle.max_cargo_height_cm ?? '-'} cm` }]
          : []),
        ...(vehicle.accepts_cargo && vehicle.accepted_cargo_categories?.length
          ? [{ label: t('vehicle.cargo_categories', { defaultValue: 'Categorías' }), value: vehicle.accepted_cargo_categories.map((c) => PACKAGE_CATEGORY_LABELS[c]?.es ?? c).join(', ') }]
          : []),
      ]
    : [];

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); fetchVehicle(); }} />;

  return (
    <Screen scroll bg="lightPrimary" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', { defaultValue: 'Back' })}
            className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
            style={{ backgroundColor: '#F1F5F9' }}
          >
            <Ionicons name="arrow-back" size={20} color="#0F172A" />
          </Pressable>
          <Text variant="h3" color="primary">{t('profile.vehicle_info')}</Text>
        </View>

        {loading ? (
          <ActivityIndicator color="#22C55E" className="mt-8" />
        ) : !vehicle ? (
          <Text variant="body" color="secondary" className="text-center mt-8">
            No hay vehículo registrado
          </Text>
        ) : (
          <>
            {/* Vehicle type image */}
            {vehicle.type && VEHICLE_IMAGES[vehicle.type] && (
              <View className="items-center mb-4">
                <Image
                  source={VEHICLE_IMAGES[vehicle.type]}
                  style={{ width: 160, height: 120, resizeMode: 'contain' }}
                  accessibilityLabel={vehicle.type}
                />
              </View>
            )}

            <Card theme="light" variant="filled" padding="md" className="bg-white">
            {infoRows.map((row) => (
              <View
                key={row.label}
                className="flex-row justify-between py-3 border-b border-[#E2E8F0]"
              >
                <Text variant="body" color="secondary">
                  {row.label}
                </Text>
                <Text variant="body" color="primary" className="font-medium">
                  {row.value}
                </Text>
              </View>
            ))}
          </Card>
          </>
        )}
      </View>
    </Screen>
  );
}
