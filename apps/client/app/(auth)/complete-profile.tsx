import React, { useEffect, useRef, useState } from 'react';
import { View, Alert, Pressable, ActionSheetIOS, Platform, KeyboardAvoidingView, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { AvatarCropModal } from '@tricigo/ui/AvatarCropModal';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Avatar } from '@tricigo/ui/Avatar';
import { useTranslation } from '@tricigo/i18n';
import { authService, referralService } from '@tricigo/api';
import { logger } from '@tricigo/utils';
import { colors, darkColors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore } from '@/stores/theme.store';
import { SwitchAccountFooter } from '@/components/auth/SwitchAccountFooter';
import { ensurePickerPermission } from '@/lib/ensurePickerPermission';
import { resizeImageForCrop } from '@/lib/compressImage';
import {
  markPickerLaunch,
  clearPickerMarker,
  consumeRecoveredPickerAsset,
} from '@/lib/cameraRecovery';

const RECOVERY_FLOW = 'avatar-complete';
// Written by app/refer/[code].tsx when a referral/influencer link opens
// before login; useDeepLinkHandler applies it after auth.
const PENDING_REFERRAL_KEY = 'pending_referral_code';
// What referralService.applyInviteCode throws for a code that matches
// neither an acquisition code nor a referral code.
const INVALID_REFERRAL_CODE_MESSAGE = 'Código de referido inválido';

interface PendingCrop {
  uri: string;
  width: number;
  height: number;
}

export default function CompleteProfileScreen() {
  const { t } = useTranslation('common');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [pendingCrop, setPendingCrop] = useState<PendingCrop | null>(null);
  // Marketing consent starts UNCHECKED: it must be an active choice, and it
  // never gates the Continue button.
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  // Optional "Código de invitación": an influencer/channel code or a
  // friend's referral code (referralService.applyInviteCode decides).
  const [inviteCode, setInviteCode] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  // The pending deep-link code the field was prefilled with, if any.
  const pendingInviteRef = useRef<string | null>(null);

  // Prefill from a deep link opened before login (tricigo.com/refer/CODE).
  // The key is NOT removed here: useDeepLinkHandler owns it, and this
  // screen only removes it once it has used (or dropped) the code itself.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(PENDING_REFERRAL_KEY)
      .then((pending) => {
        const code = pending?.trim().toUpperCase();
        if (cancelled || !code) return;
        pendingInviteRef.current = code;
        // Never overwrite something the user already typed.
        setInviteCode((current) => current || code);
      })
      .catch(() => { /* non-critical: the field just starts empty */ });
    return () => { cancelled = true; };
  }, []);

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
      // Pick at full quality; the shared circular AvatarCropModal handles framing
      // so the crop UX + output spec match the edit-profile screen (Android 13+'s
      // system picker ignores allowsEditing, so we never rely on it).
      // Mark the launch so the relaunched app can recover the photo if the OS
      // kills our process while the camera/gallery is open (cameraRecovery.ts).
      await markPickerLaunch(RECOVERY_FLOW);
      // quality 0.8 (not 1): the crop modal outputs a 384px JPEG anyway.
      const pickerResult = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
      await clearPickerMarker(); // returned alive — no recovery needed

      if (pickerResult.canceled || !pickerResult.assets[0]) return;
      const asset = pickerResult.assets[0];
      if (!asset.width || !asset.height) {
        Alert.alert(t('error'), t('errors.generic'));
        return;
      }
      // Downscale to ≤1600px BEFORE the crop modal to avoid OOM on low-RAM
      // Android with a huge photo. Returns resized dims for correct crop geometry.
      const safe = await resizeImageForCrop(asset.uri, asset.width, asset.height);
      setPendingCrop({ uri: safe.uri, width: safe.width, height: safe.height });
    } catch {
      Alert.alert(t('error'), t('errors.generic'));
    }
  };

  const handleCropConfirm = async (croppedUri: string) => {
    if (!user) return;
    setPendingCrop(null);
    setUploadingAvatar(true);
    try {
      const publicUrl = await authService.uploadAvatar(user.id, croppedUri);
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
          { text: t('profile.take_photo', { defaultValue: 'Tomar foto' }), onPress: () => pickFromSource('camera') },
          { text: t('profile.choose_photo', { defaultValue: 'Elegir de galería' }), onPress: () => pickFromSource('gallery') },
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
      // Optional invite code. Only a code that does not exist keeps the user
      // here (the name is already saved, so Continue can simply run again);
      // any other failure (own code, already used, network) never blocks
      // sign-up.
      const code = inviteCode.trim();
      if (code) {
        try {
          await referralService.applyInviteCode(user.id, code);
          // Used here, so the post-login deep-link handler must not apply
          // a stored code again on a later launch.
          AsyncStorage.removeItem(PENDING_REFERRAL_KEY).catch(() => {});
        } catch (err) {
          if (err instanceof Error && err.message === INVALID_REFERRAL_CODE_MESSAGE) {
            setInviteError(t('profile.invite_code_invalid', {
              defaultValue: 'Ese código no existe. Revísalo o deja el campo vacío.',
            }));
            return;
          }
          logger.warn('[CompleteProfile] Failed to apply invite code', { error: String(err) });
        }
      } else if (pendingInviteRef.current) {
        // The user cleared the prefilled code: respect that, instead of the
        // deep-link handler applying it on the next launch.
        AsyncStorage.removeItem(PENDING_REFERRAL_KEY).catch(() => {});
      }
      // Record the answer either way, so a "no" here is not asked again by
      // the in-app prompt. Best-effort: a failure (or a DB without the
      // columns, which returns null) must never block sign-up — the user is
      // then simply asked later, in-app.
      let withConsent: typeof updated | null = null;
      try {
        withConsent = await authService.setMarketingOptIn(user.id, marketingOptIn, 'signup');
      } catch (err) {
        logger.warn('[CompleteProfile] Failed to save marketing consent', { error: String(err) });
      }
      // Update store — the auth guard in _layout.tsx will redirect to (tabs)
      setUser(withConsent ?? updated);
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
        {/* Scrollable so the Continue button stays reachable on short screens
            with the keyboard open (the invite-code field made it taller). */}
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Welcome icon */}
          <View
            className="w-20 h-20 rounded-full items-center justify-center mb-6"
            style={{ backgroundColor: isDark ? 'rgba(255, 77, 0, 0.15)' : 'rgba(255, 77, 0, 0.08)' }}
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

          {/* Name input — UX: the Continue button stays disabled until
               the user types 2+ chars, but nothing on screen tells them
               why. A single-letter name submitted + shows a silent
               non-responsive button → confusion. An inline hint shows
               the requirement upfront so the disabled state never feels
               mysterious. Disappears once satisfied. */}
          <Input
            label={t('profile.name')}
            placeholder={t('profile.name_placeholder', { defaultValue: 'Tu nombre completo' })}
            value={fullName}
            onChangeText={setFullName}
            leftIcon={<Ionicons name="person-outline" size={20} color={isDark ? darkColors.text.secondary : colors.neutral[400]} />}
            autoFocus
          />
          {fullName.trim().length > 0 && fullName.trim().length < 2 && (
            <Text variant="caption" color="tertiary" className="mt-1 ml-1">
              {t('profile.name_min_hint', { defaultValue: 'Necesitamos al menos 2 letras para identificarte.' })}
            </Text>
          )}

          {/* Optional invite code (influencer, channel or a friend's
              referral). The hint gives way to the error when the code
              does not exist. */}
          <Input
            label={t('profile.invite_code_label', { defaultValue: 'Código de invitación (opcional)' })}
            placeholder={t('profile.invite_code_placeholder', { defaultValue: 'Ej.: MOTORENKO' })}
            value={inviteCode}
            onChangeText={(v) => { setInviteCode(v); setInviteError(null); }}
            hint={t('profile.invite_code_hint', { defaultValue: '¿Te lo dio un amigo o lo viste en redes? Escríbelo aquí.' })}
            error={inviteError ?? undefined}
            leftIcon={<Ionicons name="gift-outline" size={20} color={isDark ? darkColors.text.secondary : colors.neutral[400]} />}
            autoCapitalize="characters"
            autoCorrect={false}
            className="mt-2"
          />

          {/* Marketing consent (WhatsApp, SMS, email). Optional and
              unchecked by default — it does not gate Continue. */}
          <Pressable
            onPress={() => setMarketingOptIn((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: marketingOptIn }}
            accessibilityLabel={t('profile.marketing_opt_in_label', {
              defaultValue: 'Quiero recibir novedades y promociones de TriciGo por WhatsApp, SMS y correo.',
            })}
            hitSlop={8}
            className="flex-row items-start gap-2 mt-4"
          >
            <Ionicons
              name={marketingOptIn ? 'checkbox' : 'square-outline'}
              size={22}
              color={marketingOptIn ? colors.brand.orange : isDark ? darkColors.text.secondary : colors.neutral[400]}
              style={{ marginTop: 1 }}
            />
            <View className="flex-1">
              <Text variant="bodySmall">
                {t('profile.marketing_opt_in_label', {
                  defaultValue: 'Quiero recibir novedades y promociones de TriciGo por WhatsApp, SMS y correo.',
                })}
              </Text>
              <Text variant="caption" color="tertiary" className="mt-1">
                {t('profile.marketing_opt_in_hint', { defaultValue: 'Puedes cambiarlo cuando quieras en Ajustes.' })}
              </Text>
            </View>
          </Pressable>

          <Button
            title={t('continue', { defaultValue: 'Continuar' })}
            onPress={handleContinue}
            loading={saving}
            disabled={fullName.trim().length < 2 || saving}
            fullWidth
            size="lg"
            className="mt-4"
          />

          {/* BUG-299b: escape hatch — user who signed in with the wrong
              OAuth account (or otherwise wants to switch) can close the
              session here. Without this, the only way out was to complete
              the form (irreversible: name gets bound to current account)
              or reinstall the app. */}
          <SwitchAccountFooter />
        </ScrollView>
      </KeyboardAvoidingView>

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
