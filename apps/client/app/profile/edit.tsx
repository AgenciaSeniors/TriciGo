import React, { useState, useEffect } from 'react';
import { View, Alert, Pressable, ActionSheetIOS, Platform } from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { Avatar } from '@tricigo/ui/Avatar';
import { useTranslation } from '@tricigo/i18n';
import { i18n } from '@tricigo/i18n';
import { authService, customerService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import type { PaymentMethod, Language, CustomerProfile } from '@tricigo/types';
import { logger } from '@tricigo/utils';

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
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatar_url ?? null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  useEffect(() => {
    if (!user) return;
    customerService.ensureProfile(user.id).then((cp) => {
      setCustomerProfile(cp);
      setPaymentMethod(cp.default_payment_method);
    }).catch((err) => logger.warn('[EditProfile] Failed to load:', err));
  }, [user]);

  const pickAndUploadAvatar = async (source: 'camera' | 'gallery') => {
    if (!user) return;
    try {
      const pickerResult = source === 'camera'
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
          });

      if (pickerResult.canceled || !pickerResult.assets[0]) return;

      setUploadingAvatar(true);
      // Compress to 300×300
      const manipulated = await ImageManipulator.manipulateAsync(
        pickerResult.assets[0].uri,
        [{ resize: { width: 300, height: 300 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG },
      );

      const publicUrl = await authService.uploadAvatar(user.id, manipulated.uri);
      setAvatarUrl(publicUrl);
      setUser({ ...user, avatar_url: publicUrl });
    } catch {
      Alert.alert(t('error'), t('errors.profile_upload_failed'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleAvatarPress = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [t('cancel'), t('profile.take_photo', { defaultValue: 'Tomar foto' }), t('profile.choose_photo', { defaultValue: 'Elegir de galería' })],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) pickAndUploadAvatar('camera');
          else if (buttonIndex === 2) pickAndUploadAvatar('gallery');
        },
      );
    } else {
      Alert.alert(
        t('profile.change_photo', { defaultValue: 'Cambiar foto' }),
        '',
        [
          { text: t('cancel'), style: 'cancel' },
          { text: t('profile.take_photo', { defaultValue: 'Tomar foto' }), onPress: () => pickAndUploadAvatar('camera') },
          { text: t('profile.choose_photo', { defaultValue: 'Elegir de galería' }), onPress: () => pickAndUploadAvatar('gallery') },
        ],
      );
    }
  };

  const handleSave = async () => {
    if (!user) return;
    if (fullName.trim().length < 2) {
      Alert.alert('Error', t('profile.name_too_short', { defaultValue: 'El nombre debe tener al menos 2 caracteres' }));
      return;
    }
    const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if (email.trim() && !EMAIL_REGEX.test(email.trim())) {
      Alert.alert('Error', t('profile.invalid_email', { defaultValue: 'Ingresa un email válido' }));
      return;
    }
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
      Alert.alert(t('error'), t('errors.profile_save_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <ScreenHeader title={t('profile.edit_profile')} onBack={() => router.back()} />

        {/* Avatar */}
        <View className="items-center mb-6">
          <Avatar
            uri={avatarUrl}
            size={96}
            name={fullName || user?.full_name}
            onPress={handleAvatarPress}
            showEditBadge
            loading={uploadingAvatar}
          />
          <Pressable onPress={handleAvatarPress} className="mt-2">
            <Text variant="bodySmall" color="accent">{t('profile.change_photo', { defaultValue: 'Cambiar foto' })}</Text>
          </Pressable>
        </View>

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
