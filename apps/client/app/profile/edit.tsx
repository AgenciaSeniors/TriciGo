import React, { useEffect, useState } from 'react';
import { View, Alert, Pressable, ActionSheetIOS, Platform } from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { Avatar } from '@tricigo/ui/Avatar';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { triggerHaptic, realEmail } from '@tricigo/utils';
import Toast from 'react-native-toast-message';
import { AvatarCropModal } from '@tricigo/ui/AvatarCropModal';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '@tricigo/theme';
import { useTokens } from '@/hooks/useTokens';
import { ensurePickerPermission } from '@/lib/ensurePickerPermission';
import { resizeImageForCrop } from '@/lib/compressImage';
import {
  markPickerLaunch,
  clearPickerMarker,
  consumeRecoveredPickerAsset,
} from '@/lib/cameraRecovery';

const RECOVERY_FLOW = 'avatar-edit';

interface PendingCrop {
  uri: string;
  width: number;
  height: number;
}

export default function EditProfileScreen() {
  const { t } = useTranslation('common');
  const tokens = useTokens();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(realEmail(user?.email) ?? '');
  const [saving, setSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatar_url ?? null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [pendingCrop, setPendingCrop] = useState<PendingCrop | null>(null);

  // Recovery: if Android killed the app while the avatar camera/gallery was
  // open (common on low-RAM devices — the user sees the app "go back"), pick
  // up the captured photo on remount and reopen the crop modal with it.
  // consumeRecoveredPickerAsset is one-shot, so effect re-runs are no-ops.
  useEffect(() => {
    let cancelled = false;
    consumeRecoveredPickerAsset(RECOVERY_FLOW).then(async (rec) => {
      if (cancelled || !rec) return;
      const { asset } = rec;
      if (!asset.width || !asset.height) return;
      const safe = await resizeImageForCrop(asset.uri, asset.width, asset.height);
      if (!cancelled) setPendingCrop({ uri: safe.uri, width: safe.width, height: safe.height });
    });
    return () => { cancelled = true; };
  }, []);

  const pickFromSource = async (source: 'camera' | 'gallery') => {
    if (!user) return;
    // Ask for camera/photos permission first; without it expo-image-picker
    // throws "Missing camera or camera roll permission" on iOS (Apple 2.1(a)).
    if (!(await ensurePickerPermission(source, t))) return;
    try {
      // We do NOT request `allowsEditing` from the picker — Android 13+ uses
      // the system Photo Picker which ignores it. We always show our own
      // circular crop modal so behavior is consistent across platforms.
      // Mark the launch so the relaunched app can recover the photo if the OS
      // kills our process while the camera/gallery is open (cameraRecovery.ts).
      await markPickerLaunch(RECOVERY_FLOW);
      // quality 0.8 (not 1): the crop modal outputs a 384px JPEG anyway, so full
      // quality only bloats the intermediate file written to cache.
      const pickerResult = source === 'camera'
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.8,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.8,
          });
      await clearPickerMarker(); // returned alive — no recovery needed

      if (pickerResult.canceled || !pickerResult.assets[0]) return;

      const asset = pickerResult.assets[0];
      if (!asset.width || !asset.height) {
        // Fallback: shouldn't happen, but if dimensions are missing we abort.
        Alert.alert(
          t('error', { defaultValue: 'Error' }),
          t('errors.profile_upload_failed', {
            defaultValue: 'No se pudo procesar la imagen. Intenta otra vez.',
          }),
        );
        return;
      }

      // Downscale to ≤1600px BEFORE the crop modal so a huge gallery/camera
      // photo doesn't OOM-kill the app during the interactive crop on low-RAM
      // Android. Returns the resized dims so the crop geometry stays correct.
      const safe = await resizeImageForCrop(asset.uri, asset.width, asset.height);
      setPendingCrop({ uri: safe.uri, width: safe.width, height: safe.height });
    } catch (err) {
      const msg = String((err as { message?: string } | undefined)?.message ?? err ?? '');
      console.error('[ProfileEdit] Image pick failed:', msg);
      Alert.alert(
        t('error', { defaultValue: 'Error' }),
        t('errors.profile_upload_failed', {
          defaultValue: 'No se pudo abrir la imagen. Intenta otra vez.',
        }) + (msg ? `\n\n${msg}` : ''),
      );
    }
  };

  const handleCropConfirm = async (croppedUri: string) => {
    if (!user) return;
    setPendingCrop(null);
    setUploadingAvatar(true);
    try {
      const publicUrl = await authService.uploadAvatar(user.id, croppedUri);
      setAvatarUrl(publicUrl);
      setUser({ ...user, avatar_url: publicUrl });
      Toast.show({
        type: 'success',
        text1: t('profile.photo_updated', { defaultValue: 'Foto actualizada' }),
      });
    } catch (err) {
      const msg = String((err as { message?: string } | undefined)?.message ?? err ?? '');
      console.error('[ProfileEdit] Avatar upload failed:', msg);
      Alert.alert(
        t('error', { defaultValue: 'Error' }),
        t('errors.profile_upload_failed', {
          defaultValue: 'No se pudo subir la foto. Intenta con una imagen más pequeña.',
        }) + (msg ? `\n\n${msg}` : ''),
      );
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
          if (buttonIndex === 1) pickFromSource('camera');
          else if (buttonIndex === 2) pickFromSource('gallery');
        },
      );
    } else {
      Alert.alert(
        t('profile.change_photo', { defaultValue: 'Cambiar foto' }),
        '',
        [
          { text: t('cancel'), style: 'cancel' },
          {
            text: t('profile.take_photo', { defaultValue: 'Tomar foto' }),
            onPress: () => pickFromSource('camera'),
          },
          {
            text: t('profile.choose_photo', { defaultValue: 'Elegir de galería' }),
            onPress: () => pickFromSource('gallery'),
          },
        ],
      );
    }
  };

  const handleSave = async () => {
    if (!user) return;
    if (fullName.trim().length < 2) {
      triggerHaptic('warning');
      Toast.show({
        type: 'info',
        text1: t('profile.name_too_short', {
          defaultValue: 'El nombre debe tener al menos 2 caracteres',
        }),
      });
      return;
    }
    const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if (email.trim() && !EMAIL_REGEX.test(email.trim())) {
      triggerHaptic('warning');
      Toast.show({
        type: 'info',
        text1: t('profile.invalid_email', { defaultValue: 'Ingresa un email válido' }),
      });
      return;
    }
    setSaving(true);
    try {
      const updated = await authService.updateProfile(user.id, {
        full_name: fullName.trim(),
        email: email.trim() || null,
      });
      setUser(updated);
      Toast.show({
        type: 'success',
        text1: t('profile.profile_saved', { defaultValue: 'Perfil guardado' }),
      });
      triggerHaptic('success');
      router.back();
    } catch {
      Alert.alert(t('error'), t('errors.profile_save_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll bg="cuban" padded>
      <View className="pt-4">
        <ScreenHeader title={t('profile.edit_profile')} onBack={() => router.back()} />

        {/* Avatar with gradient ring (profile parity) */}
        <View className="items-center mb-6 mt-2">
          <LinearGradient
            colors={[colors.primary[500], colors.primary[300]]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ borderRadius: 54, padding: 3 }}
          >
            <Avatar
              uri={avatarUrl}
              size={96}
              name={fullName || user?.full_name}
              onPress={handleAvatarPress}
              showEditBadge
              loading={uploadingAvatar}
            />
          </LinearGradient>
          <Pressable onPress={handleAvatarPress} className="mt-3">
            <Text variant="bodySmall" color="accent">
              {t('profile.change_photo', { defaultValue: 'Cambiar foto' })}
            </Text>
          </Pressable>
        </View>

        {/* Form fields grouped on a Cuban surface */}
        <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 16 }}>
          <Input
            label={t('profile.name')}
            value={fullName}
            onChangeText={setFullName}
          />
          <Input
            label={t('profile.email')}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <Input label={t('profile.phone')} value={user?.phone ?? ''} editable={false} />
        </View>

        <View className="mt-4">
          <Button
            title={t('save')}
            onPress={handleSave}
            loading={saving}
            fullWidth
            size="lg"
          />
        </View>
      </View>

      <AvatarCropModal
        visible={pendingCrop !== null}
        imageUri={pendingCrop?.uri ?? null}
        imageWidth={pendingCrop?.width ?? 0}
        imageHeight={pendingCrop?.height ?? 0}
        onCancel={() => setPendingCrop(null)}
        onConfirm={handleCropConfirm}
      />
    </Screen>
  );
}
