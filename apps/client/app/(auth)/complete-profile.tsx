import React, { useState } from 'react';
import { View, Alert, Pressable, ActionSheetIOS, Platform, KeyboardAvoidingView } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Avatar } from '@tricigo/ui/Avatar';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { colors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';

export default function CompleteProfileScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

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
      const manipulated = await ImageManipulator.manipulateAsync(
        pickerResult.assets[0].uri,
        [{ resize: { width: 300, height: 300 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG },
      );

      const publicUrl = await authService.uploadAvatar(user.id, manipulated.uri);
      setAvatarUrl(publicUrl);
    } catch {
      Alert.alert(t('error'), t('errors.generic'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleAvatarPress = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [
            t('cancel'),
            t('profile.take_photo', { defaultValue: 'Tomar foto' }),
            t('profile.choose_photo', { defaultValue: 'Elegir de galería' }),
          ],
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

  const handleContinue = async () => {
    if (!user) return;
    const trimmed = fullName.trim();
    if (trimmed.length < 2) {
      Alert.alert(t('error'), t('profile.name_required', { defaultValue: 'Ingresa tu nombre completo' }));
      return;
    }

    setSaving(true);
    try {
      const updated = await authService.updateProfile(user.id, {
        full_name: trimmed,
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      });
      // Update store — the auth guard in _layout.tsx will redirect to (tabs)
      setUser(updated);
    } catch {
      Alert.alert(t('error'), t('errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen bg="white" padded={false}>
      {/* Top accent bar */}
      <LinearGradient
        colors={['#FF4D00', '#FF6B2C']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{ height: 4 }}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <View className="flex-1 justify-center px-6">
          {/* Welcome icon */}
          <View
            className="w-20 h-20 rounded-full items-center justify-center mb-6"
            style={{ backgroundColor: 'rgba(255, 77, 0, 0.08)' }}
          >
            <Ionicons name="person-circle-outline" size={40} color={colors.brand.orange} />
          </View>

          <Text variant="h3" className="mb-2">
            {t('profile.complete_title', { defaultValue: 'Completa tu perfil' })}
          </Text>
          <Text variant="body" color="secondary" className="mb-8">
            {t('profile.complete_subtitle', { defaultValue: 'Necesitamos tu nombre para que los conductores sepan quién eres' })}
          </Text>

          {/* Avatar */}
          <View className="items-center mb-6">
            <Avatar
              uri={avatarUrl}
              size={96}
              name={fullName || undefined}
              onPress={handleAvatarPress}
              showEditBadge
              loading={uploadingAvatar}
            />
            <Pressable onPress={handleAvatarPress} className="mt-2">
              <Text variant="bodySmall" color="accent">
                {t('profile.add_photo', { defaultValue: 'Agregar foto (opcional)' })}
              </Text>
            </Pressable>
          </View>

          {/* Name input */}
          <Input
            label={t('profile.name')}
            placeholder={t('profile.name_placeholder', { defaultValue: 'Tu nombre completo' })}
            value={fullName}
            onChangeText={setFullName}
            leftIcon={<Ionicons name="person-outline" size={20} color={colors.neutral[400]} />}
            autoFocus
          />

          <Button
            title={t('continue', { defaultValue: 'Continuar' })}
            onPress={handleContinue}
            loading={saving}
            disabled={fullName.trim().length < 2 || saving}
            fullWidth
            size="lg"
            className="mt-4"
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
