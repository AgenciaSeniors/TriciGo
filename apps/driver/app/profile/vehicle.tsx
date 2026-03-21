import React, { useState, useEffect } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { driverService } from '@tricigo/api';
import { useDriverStore } from '@/stores/driver.store';
import type { Vehicle } from '@tricigo/types';

export default function VehicleScreen() {
  const { t } = useTranslation('common');
  const driverProfile = useDriverStore((s) => s.profile);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!driverProfile) return;
    driverService
      .getVehicle(driverProfile.id)
      .then(setVehicle)
      .catch((err) => console.warn('[Vehicle] Failed to load:', err))
      .finally(() => setLoading(false));
  }, [driverProfile]);

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
      ]
    : [];

  return (
    <Screen scroll bg="dark" padded>
      <View className="pt-4">
        <Pressable onPress={() => router.back()} className="mb-2">
          <Text variant="body" color="accent">{t('back')}</Text>
        </Pressable>

        <Text variant="h3" color="inverse" className="mb-6">
          {t('profile.vehicle_info')}
        </Text>

        {loading ? (
          <ActivityIndicator color="#22C55E" className="mt-8" />
        ) : !vehicle ? (
          <Text variant="body" color="secondary" className="text-center mt-8">
            No hay vehículo registrado
          </Text>
        ) : (
          <Card variant="filled" padding="md" className="bg-neutral-800">
            {infoRows.map((row) => (
              <View
                key={row.label}
                className="flex-row justify-between py-3 border-b border-neutral-700"
              >
                <Text variant="body" color="secondary">
                  {row.label}
                </Text>
                <Text variant="body" color="inverse" className="font-medium">
                  {row.value}
                </Text>
              </View>
            ))}
          </Card>
        )}
      </View>
    </Screen>
  );
}
