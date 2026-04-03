import React, { useState, useEffect, useCallback } from 'react';
import { View, Alert, Pressable, ActionSheetIOS, Platform, Switch, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Avatar } from '@tricigo/ui/Avatar';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { authService, driverService } from '@tricigo/api';
import { isValidEmail, isValidCubanPhone, normalizeCubanPhone, PACKAGE_CATEGORY_LABELS } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import type { Vehicle } from '@tricigo/types';

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  triciclo: 'Triciclo',
  moto: 'Moto',
  auto: 'Auto',
};

const VEHICLE_IMAGES: Record<string, any> = {
  triciclo: require('../../assets/vehicles/selection/triciclo.png'),
  moto: require('../../assets/vehicles/selection/moto.png'),
  auto: require('../../assets/vehicles/selection/auto.png'),
};

export default function EditProfileScreen() {
  const { t } = useTranslation('common');
  const { t: td, i18n } = useTranslation('driver');
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const driverId = useDriverStore((s) => s.profile?.id);
  const driverProfile = useDriverStore((s) => s.profile);

  const lang = (i18n.language ?? 'es') as 'es' | 'en' | 'pt';

  // Form state
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatar_url ?? null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [saving, setSaving] = useState(false);

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
  const pickAndUploadAvatar = async (source: 'camera' | 'gallery') => {
    if (!user) return;
    try {
      const useGallery = Platform.OS === 'web' || source === 'gallery';
      const pickerResult = useGallery
        ? await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
          })
        : await ImagePicker.launchCameraAsync({
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
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            className="mr-3 w-10 h-10 rounded-xl bg-[#252540] items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('back')}
          >
            <Ionicons name="arrow-back" size={20} color="#FAFAFA" />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.edit_profile')}</Text>
        </View>

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
        <Input label={t('profile.name')} value={fullName} onChangeText={setFullName} />

        {/* Email with validation */}
        <Input
          label={t('profile.email')}
          value={email}
          onChangeText={(v) => { setEmail(v); setEmailError(''); }}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        {emailError ? (
          <Text variant="caption" className="text-red-400 -mt-2 mb-2 ml-1">{emailError}</Text>
        ) : null}

        {/* Phone with validation */}
        <Input
          label={t('profile.phone')}
          value={phone}
          onChangeText={(v) => { setPhone(v); setPhoneError(''); setOtpStep(false); setOtpCode(''); }}
          keyboardType="phone-pad"
        />
        {phoneError ? (
          <Text variant="caption" className="text-red-400 -mt-2 mb-2 ml-1">{phoneError}</Text>
        ) : null}

        {/* OTP input */}
        {otpStep && (
          <View className="mb-4 p-4 rounded-xl bg-[#1a1a2e] border border-white/6 border border-primary-500/30">
            <Text variant="bodySmall" color="inverse" className="mb-2">
              {td('profile.otp_sent', { phone: phone.trim(), defaultValue: 'Código enviado' })}
            </Text>
            <Input
              label={td('profile.enter_otp', { defaultValue: 'Código de verificación' })}
              value={otpCode}
              onChangeText={setOtpCode}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="000000"
            />
          </View>
        )}

        {/* ── Driver Stats ──────────────────────────────────────────────────── */}
        {driverProfile && (
          <Card variant="filled" padding="md" className="mb-4 bg-[#1a1a2e] border border-white/6">
            <View className="flex-row justify-between">
              <View className="items-center flex-1">
                <Text variant="h4" color="accent">
                  {driverProfile.rating_avg != null && !isNaN(driverProfile.rating_avg)
                    ? driverProfile.rating_avg.toFixed(1)
                    : '--'}
                </Text>
                <Text variant="caption" color="inverse" className="opacity-50">
                  {td('earnings.rating', { defaultValue: 'Rating' })}
                </Text>
              </View>
              <View className="items-center flex-1">
                <Text variant="h4" color="accent">{driverProfile.status ?? '--'}</Text>
                <Text variant="caption" color="inverse" className="opacity-50">
                  {td('common.status_label', { defaultValue: 'Estado' })}
                </Text>
              </View>
              <View className="items-center flex-1">
                <Text variant="h4" color="accent">{driverProfile.total_rides ?? 0}</Text>
                <Text variant="caption" color="inverse" className="opacity-50">
                  {td('trips_history.title', { defaultValue: 'Viajes' })}
                </Text>
              </View>
            </View>
          </Card>
        )}

        {/* ── Vehicle Card ──────────────────────────────────────────────────── */}
        {vehicle && (
          <Card variant="filled" padding="md" className="mb-4 bg-[#1a1a2e] border border-white/6">
            {/* Header with edit link */}
            <View className="flex-row items-center justify-between mb-3">
              <Text variant="label" color="inverse" className="opacity-70">
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
                <Text variant="body" color="inverse" className="font-bold">
                  {VEHICLE_TYPE_LABELS[vehicle.type] ?? vehicle.type}
                </Text>
                <Text variant="bodySmall" color="inverse" className="opacity-50">
                  {vehicle.make} {vehicle.model} ({vehicle.year})
                </Text>
              </View>
            </View>

            {/* Badges: color, placa, capacidad */}
            <View className="flex-row flex-wrap gap-2 mb-2">
              <View className="bg-[#252540] px-3 py-1.5 rounded-full">
                <Text variant="caption" color="inverse">{vehicle.color}</Text>
              </View>
              <View className="bg-[#252540] px-3 py-1.5 rounded-full">
                <Text variant="caption" color="inverse">{vehicle.plate_number}</Text>
              </View>
              <View className="bg-[#252540] px-3 py-1.5 rounded-full flex-row items-center gap-1">
                <Ionicons name="people" size={12} color="#A3A3A3" />
                <Text variant="caption" color="inverse">{vehicle.capacity} pasajeros</Text>
              </View>
            </View>

            {/* Cargo details */}
            {vehicle.accepts_cargo && (
              <>
                <View className="flex-row items-center bg-orange-900/30 rounded-lg px-3 py-2 mt-1">
                  <Ionicons name="cube" size={14} color="#FF8A5C" />
                  <Text variant="caption" className="ml-2" style={{ color: '#FF8A5C' }}>
                    {td('onboarding.accepts_deliveries', { defaultValue: 'Acepta envíos' })} — Max {vehicle.max_cargo_weight_kg} kg
                  </Text>
                </View>
                {(vehicle.max_cargo_length_cm || vehicle.max_cargo_width_cm || vehicle.max_cargo_height_cm) ? (
                  <Text variant="caption" color="inverse" className="opacity-40 mt-1 ml-1">
                    {vehicle.max_cargo_length_cm ?? '-'} × {vehicle.max_cargo_width_cm ?? '-'} × {vehicle.max_cargo_height_cm ?? '-'} cm
                  </Text>
                ) : null}
                {vehicle.accepted_cargo_categories?.length > 0 && (
                  <View className="flex-row flex-wrap gap-1 mt-2">
                    {vehicle.accepted_cargo_categories.map((cat) => (
                      <View key={cat} className="bg-[#252540] px-2 py-1 rounded-full">
                        <Text variant="caption" color="inverse" className="opacity-60">
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
        <View className="flex-row items-center justify-between py-4 px-1 mb-4 border-t border-white/6">
          <View className="flex-1 mr-4">
            <Text variant="body" color="inverse">
              {td('onboarding.accepts_deliveries', { defaultValue: 'Acepta envíos' })}
            </Text>
            <Text variant="caption" color="inverse" className="opacity-50 mt-1">
              {td('profile.accepts_deliveries_desc', { defaultValue: 'Recibe pedidos de envío de paquetes' })}
            </Text>
          </View>
          <Switch
            value={acceptsCargo}
            onValueChange={handleCargoToggle}
            trackColor={{ false: '#252540', true: colors.brand.orange }}
            thumbColor="#fff"
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
    </Screen>
  );
}
