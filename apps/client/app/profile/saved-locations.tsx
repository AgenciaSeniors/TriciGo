import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList, Alert, Pressable, RefreshControl, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors, darkColors } from '@tricigo/theme';
import { customerService } from '@tricigo/api';
import { getErrorMessage, triggerHaptic } from '@tricigo/utils';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore } from '@/stores/theme.store';
import { useRecentAddresses } from '@/hooks/useRecentAddresses';
import { AddressSearchInput } from '@/components/AddressSearchInput';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { CustomerProfile, SavedLocation } from '@tricigo/types';
import type { GeoPoint } from '@tricigo/utils';

// Lazy-load map component (web only)
let SavedLocationsMapWeb: React.ComponentType<{
  locations: { label: string; address: string; latitude: number; longitude: number }[];
  selectMode?: boolean;
  onMapClick?: (lat: number, lng: number, address: string) => void;
  selectedIndex?: number | null;
  height?: number;
}> | null = null;

if (Platform.OS === 'web') {
  try {
    SavedLocationsMapWeb = require('@/components/SavedLocationsMapWeb').default;
  } catch { /* map not available */ }
}

export default function SavedLocationsScreen() {
  const { t } = useTranslation('common');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const user = useAuthStore((s) => s.user);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [selectedAddress, setSelectedAddress] = useState<{ address: string; location: GeoPoint } | null>(null);
  const [saving, setSaving] = useState(false);
  const [mapSelectMode, setMapSelectMode] = useState(false);
  const { recentAddresses } = useRecentAddresses();

  const isWeb = Platform.OS === 'web';

  const loadLocations = useCallback(() => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    customerService.ensureProfile(user.id).then((cp) => {
      setProfile(cp);
      setLocations(cp.saved_locations ?? []);
    }).catch((err) => setError(getErrorMessage(err))).finally(() => setLoading(false));
  }, [user]);

  useEffect(() => {
    loadLocations();
  }, [loadLocations]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    if (!user) { setRefreshing(false); return; }
    customerService.ensureProfile(user.id).then((cp) => {
      setProfile(cp);
      setLocations(cp.saved_locations ?? []);
    }).catch(() => {}).finally(() => setRefreshing(false));
  }, [user]);

  const handleSave = async () => {
    if (!profile || !newLabel.trim() || !selectedAddress) return;
    setSaving(true);
    try {
      const entry: SavedLocation = {
        label: newLabel.trim(),
        address: selectedAddress.address,
        latitude: selectedAddress.location.latitude,
        longitude: selectedAddress.location.longitude,
      };

      let updated: SavedLocation[];
      if (editingIndex !== null) {
        updated = locations.map((loc, i) => (i === editingIndex ? entry : loc));
      } else {
        updated = [...locations, entry];
      }

      await customerService.updateProfile(profile.id, { saved_locations: updated });
      setLocations(updated);
      setSheetVisible(false);
      setNewLabel('');
      setSelectedAddress(null);
      setEditingIndex(null);
      setMapSelectMode(false);
      Toast.show({ type: 'success', text1: t('profile.location_saved', { defaultValue: 'Ubicacion guardada' }) });
      triggerHaptic('success');
    } catch {
      Toast.show({ type: 'error', text1: t('errors.saved_locations_failed') });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (index: number) => {
    Alert.alert('', t('profile.delete_location_confirm'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('delete'),
        style: 'destructive',
        onPress: async () => {
          if (!profile) return;
          const updated = locations.filter((_, i) => i !== index);
          try {
            await customerService.updateProfile(profile.id, { saved_locations: updated });
            setLocations(updated);
          } catch {
            Toast.show({ type: 'error', text1: t('errors.saved_locations_failed') });
          }
        },
      },
    ]);
  };

  const handleOpenSheet = (index?: number) => {
    if (index !== undefined && locations[index]) {
      const loc = locations[index]!;
      setEditingIndex(index);
      setNewLabel(loc.label);
      setSelectedAddress({
        address: loc.address,
        location: { latitude: loc.latitude, longitude: loc.longitude },
      });
    } else {
      setEditingIndex(null);
      setNewLabel('');
      setSelectedAddress(null);
    }
    setMapSelectMode(false);
    setSheetVisible(true);
  };

  const handleMapClick = useCallback((lat: number, lng: number, address: string) => {
    setSelectedAddress({ address, location: { latitude: lat, longitude: lng } });
    setMapSelectMode(false);
  }, []);

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); loadLocations(); }} />;

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <ScreenHeader title={t('profile.saved_locations_title')} onBack={() => router.back()} />

        {/* Map (web only) */}
        {isWeb && SavedLocationsMapWeb && !loading && (
          <SavedLocationsMapWeb
            locations={locations.map((l) => ({
              label: l.label,
              address: l.address,
              latitude: l.latitude,
              longitude: l.longitude,
            }))}
            selectMode={mapSelectMode}
            onMapClick={handleMapClick}
            selectedIndex={editingIndex}
          />
        )}

        <FlatList
          data={locations}
          keyExtractor={(_, i) => String(i)}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#FF4D00" />
          }
          renderItem={({ item, index }) => (
            <Card variant="outlined" padding="md" className="mb-2">
              <View className="flex-row items-center justify-between">
                <View className="flex-1 mr-3">
                  <Text variant="body" className="font-medium">{item.label}</Text>
                  <Text variant="bodySmall" color="secondary">{item.address}</Text>
                </View>
                <View className="flex-row items-center gap-3">
                  <Pressable
                    onPress={() => handleOpenSheet(index)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('profile.edit_location', { defaultValue: 'Editar ubicacion' })}
                  >
                    <Ionicons name="pencil-outline" size={18} color={isDark ? darkColors.text.secondary : colors.neutral[500]} />
                  </Pressable>
                  <Pressable
                    onPress={() => handleDelete(index)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('delete')}
                  >
                    <Ionicons name="trash-outline" size={20} color={colors.error.DEFAULT} />
                  </Pressable>
                </View>
              </View>
            </Card>
          )}
          ListEmptyComponent={
            loading ? (
              <View>
                <SkeletonListItem />
                <SkeletonListItem />
                <SkeletonListItem />
              </View>
            ) : (
              <EmptyState
                icon="location-outline"
                title={t('profile.no_saved_locations')}
                description={t('profile.no_saved_locations_desc', { defaultValue: 'Guarda tus direcciones frecuentes para reservar mas rapido.' })}
                action={{ label: t('profile.add_location'), onPress: () => handleOpenSheet() }}
              />
            )
          }
        />

        <Button
          title={t('profile.add_location')}
          variant="primary"
          size="lg"
          fullWidth
          onPress={() => handleOpenSheet()}
          className="mt-4"
        />
      </View>

      <BottomSheet visible={sheetVisible} onClose={() => { setSheetVisible(false); setEditingIndex(null); setMapSelectMode(false); }}>
        <Text className="text-lg font-bold mb-4">
          {editingIndex !== null
            ? t('profile.edit_location', { defaultValue: 'Editar ubicacion' })
            : t('profile.add_location')}
        </Text>
        <Input
          label={t('profile.location_label')}
          placeholder={t('profile.location_label_placeholder')}
          value={newLabel}
          onChangeText={setNewLabel}
        />
        <Text variant="bodySmall" color="secondary" className="mt-3 mb-2">
          {t('profile.location_address')}
        </Text>
        <AddressSearchInput
          placeholder={t('profile.location_address_placeholder', { defaultValue: 'Buscar direccion...' })}
          selectedAddress={selectedAddress?.address ?? null}
          onSelect={(address, location) => setSelectedAddress({ address, location })}
          recentAddresses={recentAddresses}
          showUseMyLocation
        />

        {/* Pick from map button (web only) */}
        {isWeb && SavedLocationsMapWeb && (
          <Pressable
            onPress={() => {
              setMapSelectMode(!mapSelectMode);
              setSheetVisible(false);
            }}
            className="flex-row items-center justify-center py-3 mt-3 rounded-lg border"
            style={{
              borderColor: mapSelectMode ? colors.primary.DEFAULT : colors.neutral[200],
              backgroundColor: mapSelectMode ? `${colors.primary.DEFAULT}10` : 'transparent',
            }}
          >
            <Ionicons
              name="location-outline"
              size={18}
              color={mapSelectMode ? colors.primary.DEFAULT : colors.neutral[600]}
            />
            <Text
              variant="bodySmall"
              className="ml-2 font-medium"
              style={{ color: mapSelectMode ? colors.primary.DEFAULT : colors.neutral[600] }}
            >
              {t('profile.pick_from_map', { defaultValue: 'Elegir en el mapa' })}
            </Text>
          </Pressable>
        )}

        {/* Selected address from map */}
        {selectedAddress && (
          <View className="flex-row items-center mt-3 p-3 rounded-lg bg-green-50">
            <Ionicons name="checkmark-circle" size={18} color="#16a34a" />
            <Text variant="bodySmall" className="ml-2 flex-1 text-green-700" numberOfLines={2}>
              {selectedAddress.address}
            </Text>
          </View>
        )}

        <View className="flex-row gap-3 mt-4">
          <View className="flex-1">
            <Button
              title={t('cancel')}
              variant="outline"
              size="lg"
              fullWidth
              onPress={() => { setSheetVisible(false); setEditingIndex(null); setMapSelectMode(false); }}
            />
          </View>
          <View className="flex-1">
            <Button
              title={t('save')}
              variant="primary"
              size="lg"
              fullWidth
              loading={saving}
              disabled={saving || !newLabel.trim() || !selectedAddress}
              onPress={handleSave}
            />
          </View>
        </View>
      </BottomSheet>
    </Screen>
  );
}
