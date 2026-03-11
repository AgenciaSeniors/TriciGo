import React, { useState, useEffect } from 'react';
import { View, Alert, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { customerService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import type { CustomerProfile } from '@tricigo/types';

export default function EmergencyContactScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    customerService.ensureProfile(user.id).then((cp) => {
      setProfile(cp);
      if (cp.emergency_contact) {
        setName(cp.emergency_contact.name);
        setPhone(cp.emergency_contact.phone);
        setRelationship(cp.emergency_contact.relationship);
      }
    }).catch((err) => console.warn('[EmergencyContact] Failed to load:', err));
  }, [user]);

  const handleSave = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      await customerService.updateProfile(profile.id, {
        emergency_contact: {
          name: name.trim(),
          phone: phone.trim(),
          relationship: relationship.trim(),
        },
      });
      router.back();
    } catch {
      Alert.alert('Error', t('errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <ScreenHeader title={t('profile.emergency_contact_title')} onBack={() => router.back()} />

        <Input
          label={t('profile.emergency_name')}
          value={name}
          onChangeText={setName}
          placeholder="Juan Pérez"
        />
        <Input
          label={t('profile.emergency_phone')}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="+53 5XXXXXXX"
        />
        <Input
          label={t('profile.emergency_relationship')}
          value={relationship}
          onChangeText={setRelationship}
          placeholder="Familiar, Amigo..."
        />

        <Button
          title={t('save')}
          onPress={handleSave}
          loading={saving}
          fullWidth
          size="lg"
          disabled={!name.trim() || !phone.trim()}
        />
      </View>
    </Screen>
  );
}
