import React, { useState, useEffect } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useTranslation } from '@tricigo/i18n';
import { colors, driverDarkColors } from '@tricigo/theme';
import { StaggeredList } from '@tricigo/ui/AnimatedCard';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import AsyncStorage from '@react-native-async-storage/async-storage';
const SAVED_ZONES_KEY = '@tricigo/saved_zones';

type SavedZone = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_km: number;
  is_primary: boolean;
};

const DEFAULT_ZONES: SavedZone[] = [
  { id: '1', name: 'La Habana Vieja', latitude: 23.1365, longitude: -82.3590, radius_km: 3, is_primary: true },
  { id: '2', name: 'Vedado', latitude: 23.1330, longitude: -82.4000, radius_km: 2, is_primary: false },
  { id: '3', name: 'Miramar', latitude: 23.1253, longitude: -82.4200, radius_km: 2.5, is_primary: false },
  { id: '4', name: 'Aeropuerto José Martí', latitude: 22.9892, longitude: -82.4094, radius_km: 5, is_primary: false },
];

export default function SavedZonesScreen() {
  const { t } = useTranslation('common');
  const [zones, setZones] = useState<SavedZone[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(SAVED_ZONES_KEY).then((val) => {
      if (val) {
        setZones(JSON.parse(val));
      } else {
        setZones(DEFAULT_ZONES);
        AsyncStorage.setItem(SAVED_ZONES_KEY, JSON.stringify(DEFAULT_ZONES));
      }
    }).catch(() => {
      setZones(DEFAULT_ZONES);
    }).finally(() => setLoading(false));
  }, []);

  const togglePrimary = (zoneId: string) => {
    const updated = zones.map((z) => ({
      ...z,
      is_primary: z.id === zoneId,
    }));
    setZones(updated);
    AsyncStorage.setItem(SAVED_ZONES_KEY, JSON.stringify(updated));
  };

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4 pb-8">
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', { defaultValue: 'Back' })}
            className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
            style={{ backgroundColor: driverDarkColors.hover }}
          >
            <Ionicons name="arrow-back" size={20} color={colors.neutral[50]} />
          </Pressable>
          <Text variant="h3" color="inverse">
            {t('profile.saved_zones', { defaultValue: 'Zonas guardadas' })}
          </Text>
        </View>

        <Text variant="bodySmall" color="secondary" className="mb-4">
          {t('profile.saved_zones_desc', { defaultValue: 'Selecciona tu zona base para priorizar solicitudes cercanas.' })}
        </Text>

        {loading && (
          <View className="gap-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}

        {!loading && zones.length === 0 && (
          <EmptyState
            forceDark
            icon="location-outline"
            title={t('profile.no_zones', { defaultValue: 'Sin zonas guardadas' })}
            description={t('profile.no_zones_desc', { defaultValue: 'Agrega zonas donde prefieres trabajar.' })}
          />
        )}

        {!loading && zones.length > 0 && (
          <StaggeredList staggerDelay={80}>
            {zones.map((zone) => (
              <Pressable
                key={zone.id}
                onPress={() => togglePrimary(zone.id)}
                className="rounded-2xl p-4 mb-3 flex-row items-center"
                style={{
                  backgroundColor: driverDarkColors.card,
                  borderWidth: 1,
                  borderColor: zone.is_primary ? colors.brand.orange : driverDarkColors.border.default,
                }}
              >
                <View
                  className="w-10 h-10 rounded-xl items-center justify-center mr-3"
                  style={{ backgroundColor: zone.is_primary ? `${colors.brand.orange}20` : driverDarkColors.hover }}
                >
                  <Ionicons
                    name={zone.is_primary ? 'location' : 'location-outline'}
                    size={20}
                    color={zone.is_primary ? colors.brand.orange : colors.neutral[500]}
                  />
                </View>
                <View className="flex-1">
                  <Text variant="body" color="inverse" className="font-semibold">{zone.name}</Text>
                  <Text variant="caption" style={{ color: colors.neutral[500] }}>
                    {t('profile.zone_radius', { defaultValue: 'Radio' })}: {zone.radius_km} km
                  </Text>
                </View>
                {zone.is_primary && (
                  <View className="px-2 py-1 rounded-full" style={{ backgroundColor: `${colors.brand.orange}20` }}>
                    <Text variant="caption" color="accent">
                      {t('profile.zone_primary', { defaultValue: 'Principal' })}
                    </Text>
                  </View>
                )}
              </Pressable>
            ))}
          </StaggeredList>
        )}
      </View>
    </Screen>
  );
}
