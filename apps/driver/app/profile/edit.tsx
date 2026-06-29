import React, { useState, useEffect, useCallback } from 'react';
import { View, Alert, Pressable, ActionSheetIOS, Platform, Switch, Image, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Avatar } from '@tricigo/ui/Avatar';
import { AvatarCropModal } from '@tricigo/ui/AvatarCropModal';
import { Card } from '@tricigo/ui/Card';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark } from '@tricigo/theme';
import { authService, driverService } from '@tricigo/api';
import { isValidEmail, isValidCubanPhone, normalizeCubanPhone, PACKAGE_CATEGORY_LABELS, realEmail } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { ensurePickerPermission } from '@/lib/ensurePickerPermission';
import type { Vehicle } from '@tricigo/types';

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  triciclo: 'Triciclo',
  moto: 'Moto',
  auto: 'Auto',
  confort: 'Confort',
};

const VEHICLE_IMAGES: Record<string, any> = {
  triciclo: require('../../assets/vehicles/selection/triciclo.png'),
  moto: require('../../assets/vehicles/selection/moto.png'),
  // Auto card uses the side-view sedan (selection/); the top-down
  // almendrón marker stays on the live map only.
  auto: require('../../assets/vehicles/selection/auto.png'),
  confort: require('../../assets/vehicles/selection/confort.png'),
};

export default function EditProfileScreen() {
  const { t } = useTranslation('common');
  const { t: td, i18n } = useTranslation('driver');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const driverId = useDriverStore((s) => s.profile?.id);
  const driverProfile = useDriverStore((s) => s.profile);

  const lang = (i18n.language ?? 'es') as 'es' | 'en' | 'pt';

  // Form state
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(realEmail(user?.email) ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatar_url ?? null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  // Pending crop — when the user picks a photo, we open the AvatarCropModal
  // (parity D1 with client). Stays null until the modal confirms or cancels.
  const [pendingCrop, setPendingCrop] = useState<{ uri: string; width: number; height: number } | null>(null);

  // Vehicle state (full object)
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const acceptsCargo = vehicle?.accepts_cargo ?? false;
  const vehicleId = vehicle?.id ?? null;

  // Validation errors
  const [emailError, setEmailError] = useState('');
  const [phoneError, setPhoneError] = useState('');

  // OTP state
  const [otpStep, setOtpStep] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [sendingOtp, setSendingOtp] = useState(false);

  // Load vehicle on mount
  useEffect(() => {
    if (!driverId) return;
    driverService.getVehicle(driverId).then((v) => {
      if (v) setVehicle(v);
    }).catch(() => {});
  }, [driverId]);

  // Refresh vehicle when returning from cargo-settings or edit-vehicle
  useFocusEffect(
    useCallback(() => {
      if (driverId) {
        driverService.getVehicle(driverId).then((v) => {
          if (v) setVehicle(v);
        }).catch(() => {});
      }
    }, [driverId]),
  );

  // ── Avatar ──────────────────────────────────────────────────────────────────
  // Picker abre el sistema photo picker (Android 13+ no respeta allowsEditing,
  // por eso lo quitamos y delegamos el crop al `<AvatarCropModal />` shared
  // que tiene la misma UX cross-platform que el cliente. Output spec
  // garantizado: 384×384 JPEG q=0.7).
  const pickAndUploadAvatar = async (source: 'camera' | 'gallery') => {
    if (!user) return;
    const useGallery = Platform.OS === 'web' || source === 'gallery';
    // Ask for camera/photos permission first; without it expo-image-picker
    // throws "Missing camera or camera roll permission" on iOS (Apple 2.1(a)).
    if (!(await ensurePickerPermission(useGallery ? 'gallery' : 'camera', t))) return;
    try {
      const pickerResult = useGallery
        ? await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 1,
          })
        : await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 1,
          });

      if (pickerResult.canceled || !pickerResult.assets[0]) return;

      const asset = pickerResult.assets[0];
      if (!asset.width || !asset.height) {
        Alert.alert('Error', t('errors.generic'));
        return;
      }
      // Open the shared crop modal — confirm dispara el upload real.
      setPendingCrop({ uri: asset.uri, width: asset.width, height: asset.height });
    } catch {
      Alert.alert('Error', t('errors.generic'));
    }
  };

  // Called when the user confirms the crop. Receives a 384×384 JPEG URI
  // ready to upload (no resize needed — el AvatarCropModal output ya está
  // dimensionado correctamente).
  const handleCropConfirm = async (croppedUri: string) => {
    if (!user) return;
    setPendingCrop(null);
    setUploadingAvatar(true);
    try {
      const publicUrl = await authService.uploadAvatar(user.id, croppedUri);
      setAvatarUrl(publicUrl);
      setUser({ ...user, avatar_url: publicUrl });
    } catch {
      Alert.alert('Error', t('errors.generic'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleAvatarPress = () => {
    if (Platform.OS === 'web') {
      pickAndUploadAvatar('gallery');
      return;
    }
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

  // ── Cargo toggle ────────────────────────────────────────────────────────────
  const handleCargoToggle = (value: boolean) => {
    if (value) {
      router.push('/profile/cargo-settings');
    } else {
      Alert.alert(
        td('profile.cargo_disabled_confirm', { defaultValue: '¿Dejar de aceptar envíos?' }),
        td('profile.cargo_disabled_msg', { defaultValue: 'Ya no recibirás pedidos de envío de paquetes.' }),
        [
          { text: t('cancel'), style: 'cancel' },
          {
            text: t('confirm', { defaultValue: 'Confirmar' }),
            style: 'destructive',
            onPress: async () => {
              if (!vehicleId) return;
              try {
                await driverService.updateVehicleCargo(vehicleId, { accepts_cargo: false });
                setVehicle((prev) => prev ? { ...prev, accepts_cargo: false } : prev);
              } catch {
                Alert.alert('Error', t('errors.generic'));
              }
            },
          },
        ],
      );
    }
  };

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!user) return;

    setEmailError('');
    setPhoneError('');

    if (email.trim() && !isValidEmail(email.trim())) {
      setEmailError(td('profile.invalid_email', { defaultValue: 'El correo no es válido' }));
      return;
    }

    const phoneChanged = phone.trim() !== (user.phone ?? '');

    if (phoneChanged) {
      const normalized = normalizeCubanPhone(phone.trim());
      if (!normalized) {
        setPhoneError(td('profile.invalid_phone', { defaultValue: 'El número no es válido' }));
        return;
      }

      if (!otpStep) {
        setSendingOtp(true);
        try {
          await authService.sendOTP(normalized);
          setOtpStep(true);
        } catch {
          Alert.alert('Error', t('errors.generic'));
        } finally {
          setSendingOtp(false);
        }
        return;
      }

      if (!otpCode || otpCode.length < 6) {
        Alert.alert('Error', td('profile.invalid_otp', { defaultValue: 'Código incorrecto' }));
        return;
      }
      try {
        const normalized2 = normalizeCubanPhone(phone.trim())!;
        await authService.verifyPhoneLink(normalized2, otpCode);
      } catch {
        Alert.alert('Error', td('profile.invalid_otp', { defaultValue: 'Código incorrecto' }));
        return;
      }
    }

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
    <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4">
        <ProfileScreenHeader
          title={t('profile.edit_profile')}
          onBack={() => router.back()}
          backAccessibilityLabel={t('back')}
        />

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

        {/* Name */}
        <Input label={t('profile.name')} value={fullName} onChangeText={setFullName} variant="light" />

        {/* Email with validation */}
        <Input
          label={t('profile.email')}
          value={email}
          onChangeText={(v) => { setEmail(v); setEmailError(''); }}
          keyboardType="email-address"
          autoCapitalize="none"
          variant="light"
        />
        {emailError ? (
          <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="-mt-2 mb-2 ml-1">{emailError}</Text>
        ) : null}

        {/* Phone with validation */}
        <Input
          label={t('profile.phone')}
          value={phone}
          onChangeText={(v) => { setPhone(v); setPhoneError(''); setOtpStep(false); setOtpCode(''); }}
          keyboardType="phone-pad"
          variant="light"
        />
        {phoneError ? (
          <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="-mt-2 mb-2 ml-1">{phoneError}</Text>
        ) : null}

        {/* OTP input */}
        {otpStep && (
          <View className="mb-4 p-4 rounded-xl border" style={{ backgroundColor: midnightEmber.screen.bg.sunken, borderColor: `${midnightEmber.accent[500]}4D` }}>
            <Text variant="bodySmall" color="primary" className="mb-2">
              {td('profile.otp_sent', { phone: phone.trim(), defaultValue: 'Código enviado' })}
            </Text>
            <Input
              label={td('profile.enter_otp', { defaultValue: 'Código de verificación' })}
              value={otpCode}
              onChangeText={setOtpCode}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="000000"
              variant="light"
            />
          </View>
        )}

        {/* ── Driver Stats ──────────────────────────────────────────────────── */}
        {driverProfile && (
          <Card theme="light" variant="filled" padding="md" className="mb-4 border"
            style={{ backgroundColor: midnightEmber.screen.bg.surface, borderColor: midnightEmber.screen.line.default }}>
            <View className="flex-row justify-between">
              <View className="items-center flex-1">
                <Text variant="h4" color="accent">
                  {driverProfile.rating_avg != null && !isNaN(driverProfile.rating_avg)
                    ? driverProfile.rating_avg.toFixed(1)
                    : '--'}
                </Text>
                <Text variant="caption" color="primary" className="opacity-50">
                  {td('earnings.rating', { defaultValue: 'Rating' })}
                </Text>
              </View>
              <View className="items-center flex-1">
                <Text variant="h4" color="accent">{driverProfile.status ? td(`common.status_${driverProfile.status}`, { defaultValue: driverProfile.status }) : '--'}</Text>
                <Text variant="caption" color="primary" className="opacity-50">
                  {td('common.status_label', { defaultValue: 'Estado' })}
                </Text>
              </View>
              <View className="items-center flex-1">
                <Text variant="h4" color="accent">{driverProfile.total_rides_completed ?? driverProfile.total_rides ?? 0}</Text>
                <Text variant="caption" color="primary" className="opacity-50">
                  {td('trips_history.title', { defaultValue: 'Viajes' })}
                </Text>
              </View>
            </View>
          </Card>
        )}

        {/* ── Vehicle Card ──────────────────────────────────────────────────── */}
        {vehicle && (
          <Card theme="light" variant="filled" padding="md" className="mb-4 border"
            style={{ backgroundColor: midnightEmber.screen.bg.surface, borderColor: midnightEmber.screen.line.default }}>
            {/* Header with edit link */}
            <View className="flex-row items-center justify-between mb-3">
              <Text variant="label" color="primary" className="opacity-70">
                {t('profile.vehicle_info')}
              </Text>
              <Pressable onPress={() => router.push('/profile/edit-vehicle')}>
                <Text variant="bodySmall" color="accent">
                  {td('profile.edit_vehicle', { defaultValue: 'Editar vehículo' })}
                </Text>
              </Pressable>
            </View>

            {/* Vehicle image + type + make/model */}
            <View className="flex-row items-center mb-3">
              {vehicle.type && VEHICLE_IMAGES[vehicle.type] && (
                <Image
                  source={VEHICLE_IMAGES[vehicle.type]}
                  style={{ width: 64, height: 64, marginRight: 12 }}
                  resizeMode="contain"
                />
              )}
              <View className="flex-1">
                <Text variant="body" color="primary" className="font-bold">
                  {VEHICLE_TYPE_LABELS[vehicle.type] ?? vehicle.type}
                </Text>
                <Text variant="bodySmall" color="primary" className="opacity-50">
                  {vehicle.make} {vehicle.model} ({vehicle.year})
                </Text>
              </View>
            </View>

            {/* Badges: color, placa, capacidad */}
            <View className="flex-row flex-wrap gap-2 mb-2">
              <View className="px-3 py-1.5 rounded-full" style={{ backgroundColor: midnightEmber.screen.bg.sunken }}>
                <Text variant="caption" color="primary">{vehicle.color}</Text>
              </View>
              <View className="px-3 py-1.5 rounded-full" style={{ backgroundColor: midnightEmber.screen.bg.sunken }}>
                <Text variant="caption" color="primary">{vehicle.plate_number}</Text>
              </View>
              <View className="px-3 py-1.5 rounded-full flex-row items-center gap-1" style={{ backgroundColor: midnightEmber.screen.bg.sunken }}>
                <Ionicons name="people" size={12} color={midnightEmber.screen.text.tertiary} />
                <Text variant="caption" color="primary">{vehicle.capacity} pasajeros</Text>
              </View>
            </View>

            {/* Cargo details */}
            {vehicle.accepts_cargo && (
              <>
                <View className="flex-row items-center rounded-lg px-3 py-2 mt-1" style={{ backgroundColor: `${midnightEmber.accent[500]}1A` }}>
                  <Ionicons name="cube" size={14} color={midnightEmber.accent[300]} />
                  <Text variant="caption" className="ml-2" style={{ color: midnightEmber.accent[300] }}>
                    {td('onboarding.accepts_deliveries', { defaultValue: 'Acepta envíos' })} — Max {vehicle.max_cargo_weight_kg} kg
                  </Text>
                </View>
                {(vehicle.max_cargo_length_cm || vehicle.max_cargo_width_cm || vehicle.max_cargo_height_cm) ? (
                  <Text variant="caption" color="primary" className="opacity-40 mt-1 ml-1">
                    {vehicle.max_cargo_length_cm ?? '-'} × {vehicle.max_cargo_width_cm ?? '-'} × {vehicle.max_cargo_height_cm ?? '-'} cm
                  </Text>
                ) : null}
                {vehicle.accepted_cargo_categories?.length > 0 && (
                  <View className="flex-row flex-wrap gap-1 mt-2">
                    {vehicle.accepted_cargo_categories.map((cat) => (
                      <View key={cat} className="px-2 py-1 rounded-full" style={{ backgroundColor: midnightEmber.screen.bg.sunken }}>
                        <Text variant="caption" color="primary" className="opacity-60">
                          {PACKAGE_CATEGORY_LABELS[cat]?.[lang] ?? cat}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </Card>
        )}

        {/* ── Accepts deliveries toggle ─────────────────────────────────────── */}
        <View className="flex-row items-center justify-between py-4 px-1 mb-4 border-t" style={{ borderTopColor: midnightEmber.screen.line.default }}>
          <View className="flex-1 mr-4">
            <Text variant="body" color="primary">
              {td('onboarding.accepts_deliveries', { defaultValue: 'Acepta envíos' })}
            </Text>
            <Text variant="caption" color="primary" className="opacity-50 mt-1">
              {td('profile.accepts_deliveries_desc', { defaultValue: 'Recibe pedidos de envío de paquetes' })}
            </Text>
          </View>
          <Switch
            value={acceptsCargo}
            onValueChange={handleCargoToggle}
            trackColor={{ false: midnightEmber.screen.line.default, true: midnightEmber.accent[500] }}
            thumbColor={midnightEmber.screen.bg.surface}
            accessibilityLabel={td('onboarding.accepts_deliveries', { defaultValue: 'Acepta envíos' })}
          />
        </View>

        {/* Save button */}
        <Button
          title={otpStep ? td('profile.verify_phone', { defaultValue: 'Verificar y guardar' }) : t('save')}
          onPress={handleSave}
          loading={saving || sendingOtp}
          fullWidth
          size="lg"
        />
      </View>

      {/* Shared avatar crop modal — same UX as client (parity D1).
          Drag/zoom + circular guide + 384×384 JPEG q=0.7 output. */}
      <AvatarCropModal
        visible={pendingCrop !== null}
        imageUri={pendingCrop?.uri ?? null}
        imageWidth={pendingCrop?.width ?? 0}
        imageHeight={pendingCrop?.height ?? 0}
        onCancel={() => setPendingCrop(null)}
        onConfirm={handleCropConfirm}
      />
      </View>
    </Screen>
  );
}
