import React, { useState, useEffect } from 'react';
import { View, Alert, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { i18n } from '@tricigo/i18n';
import { authService, customerService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import type { PaymentMethod, Language, CustomerProfile } from '@tricigo/types';

const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
];

const PAYMENT_METHODS: { value: PaymentMethod; labelKey: string }[] = [
  { value: 'cash', labelKey: 'profile.payment_cash' },
  { value: 'tricicoin', labelKey: 'profile.payment_tricicoin' },
  { value: 'mixed', labelKey: 'profile.payment_mixed' },
];

export default function EditProfileScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [language, setLanguage] = useState<Language>(user?.preferred_language ?? 'es');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [customerProfile, setCustomerProfile] = useState<CustomerProfile | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    customerService.ensureProfile(user.id).then((cp) => {
      setCustomerProfile(cp);
      setPaymentMethod(cp.default_payment_method);
    }).catch(() => {});
  }, [user]);

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

      if (customerProfile && paymentMethod !== customerProfile.default_payment_method) {
        await customerService.updateProfile(customerProfile.id, {
          default_payment_method: paymentMethod,
        });
      }

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
        <Pressable onPress={() => router.back()} className="mb-2">
          <Text variant="body" color="accent">{t('back')}</Text>
        </Pressable>

        <Text variant="h3" className="mb-6">{t('profile.edit_profile')}</Text>

        <Input label={t('profile.name')} value={fullName} onChangeText={setFullName} />
        <Input label={t('profile.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <Input label={t('profile.phone')} value={user?.phone ?? ''} editable={false} />

        {/* Language selector */}
        <Text variant="label" className="mb-2 text-neutral-700">{t('profile.preferred_language')}</Text>
        <View className="flex-row gap-2 mb-6">
          {LANGUAGES.map((lang) => (
            <Pressable
              key={lang.value}
              onPress={() => setLanguage(lang.value)}
              className={`flex-1 py-3 rounded-lg items-center border ${
                language === lang.value
                  ? 'bg-primary-500 border-primary-500'
                  : 'bg-white border-neutral-200'
              }`}
            >
              <Text
                variant="body"
                color={language === lang.value ? 'inverse' : 'primary'}
                className="font-medium"
              >
                {lang.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Payment method */}
        <Text variant="label" className="mb-2 text-neutral-700">{t('profile.payment_method')}</Text>
        <View className="flex-row gap-2 mb-6">
          {PAYMENT_METHODS.map((pm) => (
            <Pressable
              key={pm.value}
              onPress={() => setPaymentMethod(pm.value)}
              className={`flex-1 py-3 rounded-lg items-center border ${
                paymentMethod === pm.value
                  ? 'bg-primary-500 border-primary-500'
                  : 'bg-white border-neutral-200'
              }`}
            >
              <Text
                variant="bodySmall"
                color={paymentMethod === pm.value ? 'inverse' : 'primary'}
                className="font-medium"
              >
                {t(pm.labelKey)}
              </Text>
            </Pressable>
          ))}
        </View>

        <Button title={t('save')} onPress={handleSave} loading={saving} fullWidth size="lg" />
      </View>
    </Screen>
  );
}
