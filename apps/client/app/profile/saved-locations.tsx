import React, { useState, useEffect } from 'react';
import { View, FlatList, Alert, Pressable } from 'react-native';
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
import { colors } from '@tricigo/theme';
import { customerService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useRecentAddresses } from '@/hooks/useRecentAddresses';
import { AddressSearchInput } from '@/components/AddressSearchInput';
import type { CustomerProfile, SavedLocation } from '@tricigo/types';
import type { GeoPoint } from '@tricigo/utils';

export default function SavedLocationsScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [selectedAddress, setSelectedAddress] = useState<{ address: string; location: GeoPoint } | null>(null);
  const [saving, setSaving] = useState(false);
  const { recentAddresses } = useRecentAddresses();

  useEffect(() => {
    if (!user) return;
    customerService.ensureProfile(user.id).then((cp) => {
      setProfile(cp);
      setLocations(cp.saved_locations ?? []);
    }).catch((err) => console.warn('[SavedLocations] Failed to load:', err)).finally(() => setLoading(false));
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
        // Edit existing
        updated = locations.map((loc, i) => (i === editingIndex ? entry : loc));
      } else {
        // Add new
        updated = [...locations, entry];
      }

      await customerService.updateProfile(profile.id, { saved_locations: updated });
      setLocations(updated);
      setSheetVisible(false);
      setNewLabel('');
      setSelectedAddress(null);
      setEditingIndex(null);
    } catch {
      Alert.alert(t('error'), t('errors.generic'));
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
            Alert.alert(t('error'), t('errors.generic'));
          }
        },
      },
    ]);
  };

  const handleOpenSheet = (index?: number) => {
    if (index !== undefined && locations[index]) {
      // Edit mode — pre-populate
      const loc = locations[index]!;
      setEditingIndex(index);
      setNewLabel(loc.label);
      setSelectedAddress({
        address: loc.address,
        location: { latitude: loc.latitude, longitude: loc.longitude },
      });
    } else {
      // Add mode
      setEditingIndex(null);
      setNewLabel('');
      setSelectedAddress(null);
    }
    setSheetVisible(true);
  };

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <ScreenHeader title={t('profile.saved_locations_title')} onBack={() => router.back()} />

        <FlatList
          data={locations}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item, index }) => (
            <Card variant="outlined" padding="md" className="mb-2">
              <View className="flex-row items-center justify-between">
                <Pressable
                  className="flex-1 mr-3"
                  onPress={() => handleOpenSheet(index)}
                  accessibilityRole="button"
                  accessibilityLabel={t('profile.edit_location', { defaultValue: 'Editar ubicación' })}
                >
                  <Text variant="body" className="font-medium">{item.label}</Text>
                  <Text variant="bodySmall" color="secondary">{item.address}</Text>
                </Pressable>
                <View className="flex-row items-center gap-3">
                  <Pressable
                    onPress={() => handleOpenSheet(index)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('profile.edit_location', { defaultValue: 'Editar ubicación' })}
                  >
                    <Ionicons name="pencil-outline" size={18} color={colors.neutral[500]} />
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
            !loading ? (
              <Text variant="body" color="secondary" className="text-center py-8">
                {t('profile.no_saved_locations')}
              </Text>
            ) : null
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

      <BottomSheet visible={sheetVisible} onClose={() => { setSheetVisible(false); setEditingIndex(null); }}>
        <Text className="text-lg font-bold mb-4">
          {editingIndex !== null
            ? t('profile.edit_location', { defaultValue: 'Editar ubicación' })
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
          placeholder={t('profile.location_address_placeholder', { defaultValue: 'Buscar dirección...' })}
          selectedAddress={selectedAddress?.address ?? null}
          onSelect={(address, location) => setSelectedAddress({ address, location })}
          recentAddresses={recentAddresses}
          showUseMyLocation
        />
        <View className="mt-4">
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
      </BottomSheet>
    </Screen>
  );
}
