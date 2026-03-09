import React, { useState } from 'react';
import { View, Alert } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from 'react-i18next';
import { authService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';

export default function EditProfileScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const updated = await authService.updateProfile(user.id, {
        full_name: fullName.trim(),
        email: email.trim() || null,
      });
      setUser(updated);
      router.back();
    } catch {
      Alert.alert('Error', t('errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll bg="dark" padded>
      <View className="pt-4">
        <Text variant="h3" color="inverse" className="mb-6">{t('profile.edit_profile')}</Text>
        <Input label={t('profile.name')} value={fullName} onChangeText={setFullName} />
        <Input label={t('profile.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <Input label={t('profile.phone')} value={user?.phone ?? ''} editable={false} />
        <Button title={t('save')} onPress={handleSave} loading={saving} fullWidth size="lg" />
      </View>
    </Screen>
  );
}
