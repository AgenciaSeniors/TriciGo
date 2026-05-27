import React, { useState, useEffect, useCallback } from 'react';
import { View, ActivityIndicator, Image, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark, colors } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { useDriverStore } from '@/stores/driver.store';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { Vehicle } from '@tricigo/types';
import { PACKAGE_CATEGORY_LABELS } from '@tricigo/utils';

const VEHICLE_IMAGES: Record<string, any> = {
  triciclo: require('../../assets/vehicles/selection/triciclo.png'),
  moto: require('../../assets/vehicles/selection/moto.png'),
  // Web.docx 2026-05-08: "auto es el almendrón cubano"
  auto: require('../../assets/vehicles/markers/auto_clasico.png'),
  confort: require('../../assets/vehicles/selection/confort.png'),
};

export default function VehicleScreen() {
  const { t } = useTranslation('common');
  const driverProfile = useDriverStore((s) => s.profile);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cuban palette
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const CARD_SHADOW = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.4 : 0.06,
    shadowRadius: 8,
    elevation: 2,
  };

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
    <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }} className="pt-4">
        <ProfileScreenHeader
          title={t('profile.vehicle_info')}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back', { defaultValue: 'Back' })}
        />

        {loading ? (
          <ActivityIndicator color={colors.brand.orange} className="mt-8" />
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

            <View style={{ backgroundColor: palette.bg.elev1, borderRadius: 16, padding: 14, ...CARD_SHADOW }}>
              {infoRows.map((row, i) => (
                <View
                  key={row.label}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    paddingVertical: 12,
                    borderBottomWidth: i === infoRows.length - 1 ? 0 : 1,
                    borderBottomColor: palette.line,
                  }}
                >
                  <Text style={{ color: palette.ink.secondary, fontSize: 14 }}>
                    {row.label}
                  </Text>
                  <Text style={{ color: palette.ink.primary, fontSize: 14, fontWeight: '600' }}>
                    {row.value}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}

// midnightEmber kept imported (no-op) for potential future fallback wiring.
void midnightEmber;
