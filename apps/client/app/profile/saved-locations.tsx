import React, { useState, useEffect } from 'react';
import { View, FlatList, ScrollView, Alert, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { customerService } from '@tricigo/api';
import { HAVANA_PRESETS } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import type { CustomerProfile, SavedLocation } from '@tricigo/types';

export default function SavedLocationsScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    customerService.ensureProfile(user.id).then((cp) => {
      setProfile(cp);
      setLocations(cp.saved_locations ?? []);
    }).catch((err) => console.warn('[SavedLocations] Failed to load:', err)).finally(() => setLoading(false));
  }, [user]);

  const handleAdd = async () => {
    if (!profile || !newLabel.trim() || selectedPreset === null) return;
    setSaving(true);
    try {
      const preset = HAVANA_PRESETS[selectedPreset]!;
      const updated = [...locations, {
        label: newLabel.trim(),
        address: preset.address,
        latitude: preset.latitude,
        longitude: preset.longitude,
      }];
      await customerService.updateProfile(profile.id, { saved_locations: updated });
      setLocations(updated);
      setSheetVisible(false);
      setNewLabel('');
      setSelectedPreset(null);
    } catch {
      Alert.alert('Error', t('errors.generic'));
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
            Alert.alert('Error', t('errors.generic'));
          }
        },
      },
    ]);
  };

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <Pressable onPress={() => router.back()} className="mb-2">
          <Text variant="body" color="accent">{t('back')}</Text>
        </Pressable>

        <Text variant="h3" className="mb-6">{t('profile.saved_locations_title')}</Text>

        <FlatList
          data={locations}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item, index }) => (
            <Card variant="outlined" padding="md" className="mb-2">
              <View className="flex-row items-center justify-between">
                <View className="flex-1 mr-3">
                  <Text variant="body" className="font-medium">{item.label}</Text>
                  <Text variant="bodySmall" color="secondary">{item.address}</Text>
                </View>
                <Pressable onPress={() => handleDelete(index)}>
                  <Ionicons name="trash-outline" size={20} color="#EF4444" />
                </Pressable>
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
          onPress={() => setSheetVisible(true)}
          className="mt-4"
        />
      </View>

      <BottomSheet visible={sheetVisible} onClose={() => setSheetVisible(false)}>
        <Text className="text-lg font-bold mb-4">{t('profile.add_location')}</Text>
        <Input
          label={t('profile.location_label')}
          placeholder="Casa, Trabajo..."
          value={newLabel}
          onChangeText={setNewLabel}
        />
        <Text variant="bodySmall" color="secondary" className="mt-3 mb-2">
          {t('profile.location_address')}
        </Text>
        <ScrollView style={{ maxHeight: 220 }} className="mb-4">
          {HAVANA_PRESETS.map((preset, idx) => (
            <Pressable
              key={idx}
              onPress={() => setSelectedPreset(idx)}
              className={`p-3 rounded-lg mb-2 border ${
                selectedPreset === idx ? 'border-primary-500 bg-primary-50' : 'border-neutral-200'
              }`}
            >
              <Text variant="body">{preset.label}</Text>
              <Text variant="bodySmall" color="secondary">{preset.address}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <Button
          title={saving ? '...' : t('save')}
          variant="primary"
          size="lg"
          fullWidth
          disabled={saving || !newLabel.trim() || selectedPreset === null}
          onPress={handleAdd}
        />
      </BottomSheet>
    </Screen>
  );
}
