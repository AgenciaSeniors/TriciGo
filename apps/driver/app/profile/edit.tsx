import React, { useState } from 'react';
import { View, Alert, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation, i18n } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';

type Language = 'es' | 'en';

const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
];

export default function EditProfileScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [language, setLanguage] = useState<Language>(
    (user?.preferred_language as Language) ?? 'es',
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const updated = await authService.updateProfile(user.id, {
        full_name: fullName.trim(),
        email: email.trim() || null,
        preferred_language: language,
      });
      setUser(updated);
      i18n.changeLanguage(language);
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
        <Pressable onPress={() => router.back()} className="mb-2">
          <Text variant="body" color="accent">{t('back')}</Text>
        </Pressable>

        <Text variant="h3" color="inverse" className="mb-6">{t('profile.edit_profile')}</Text>

        <Input label={t('profile.name')} value={fullName} onChangeText={setFullName} />
        <Input label={t('profile.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <Input label={t('profile.phone')} value={user?.phone ?? ''} editable={false} />

        {/* Language selector */}
        <Text variant="bodySmall" color="secondary" className="mb-2 mt-2">
          {t('profile.preferred_language')}
        </Text>
        <View className="flex-row mb-6">
          {LANGUAGES.map((lang) => (
            <Pressable
              key={lang.value}
              onPress={() => setLanguage(lang.value)}
              className={`flex-1 py-3 rounded-lg items-center mr-2 ${
                language === lang.value ? 'bg-primary-500' : 'bg-neutral-800'
              }`}
            >
              <Text
                variant="body"
                color={language === lang.value ? 'inverse' : 'secondary'}
              >
                {lang.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Button title={t('save')} onPress={handleSave} loading={saving} fullWidth size="lg" />
      </View>
    </Screen>
  );
}
