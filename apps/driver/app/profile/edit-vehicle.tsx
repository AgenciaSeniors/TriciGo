import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, Alert, Image, Platform, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import Toast from 'react-native-toast-message';
import { compressDocument, formatSizeDelta } from '@/lib/compressDocument';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { isValidPlateNumber } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';
import { ensurePickerPermission } from '@/lib/ensurePickerPermission';
import {
  markPickerLaunch,
  clearPickerMarker,
  consumeRecoveredPickerAsset,
} from '@/lib/cameraRecovery';
import type { VehicleType, DocumentType } from '@tricigo/types';

const RECOVERY_FLOW = 'edit-vehicle-photo';

// ── Vehicle type configs ──────────────────────────────────────────────────────
const VEHICLE_CONFIGS = [
  {
    vehicleType: 'triciclo' as VehicleType,
    label: 'Triciclo',
    defaultCapacity: 3,
    maxCapacity: 8,
    image: require('../../assets/vehicles/selection/triciclo.png'),
    accent: midnightEmber.accent[500],
  },
  {
    vehicleType: 'moto' as VehicleType,
    label: 'Moto',
    defaultCapacity: 1,
    maxCapacity: 1,
    image: require('../../assets/vehicles/selection/moto.png'),
    accent: midnightEmber.state.info,
  },
  {
    vehicleType: 'auto' as VehicleType,
    label: 'Auto',
    defaultCapacity: 4,
    maxCapacity: 16,
    // Web.docx 2026-05-08: "auto es el almendrón cubano". Mirror
    // onboarding/vehicle-info.tsx so the post-onboarding edit screen
    // shows the same Auto image as the registration step.
    image: require('../../assets/vehicles/selection/auto.png'),
    accent: midnightEmber.state.success,
  },
  {
    // 00263: 'confort' is now a first-class vehicle_type; this
    // selector mirrors the onboarding screen so a driver can
    // upgrade an existing 'auto' to 'confort' (or vice versa)
    // post-onboarding without losing the slug.
    vehicleType: 'confort' as VehicleType,
    label: 'Confort',
    defaultCapacity: 4,
    maxCapacity: 16,
    image: require('../../assets/vehicles/selection/confort.png'),
    accent: '#A855F7',
  },
];

// ── Photo doc types ───────────────────────────────────────────────────────────
interface PhotoDoc {
  type: DocumentType;
  labelKey: string;
  defaultLabel: string;
  icon: keyof typeof Ionicons.glyphMap;
  uri: string | null;
  uploading: boolean;
  uploaded: boolean;
  error: string | null;
}

const INITIAL_PHOTOS: PhotoDoc[] = [
  { type: 'vehicle_photo', labelKey: 'profile.vehicle_photo_label', defaultLabel: 'Foto del vehículo', icon: 'car', uri: null, uploading: false, uploaded: false, error: null },
  { type: 'vehicle_registration', labelKey: 'profile.plate_photo', defaultLabel: 'Foto de matrícula', icon: 'document-text', uri: null, uploading: false, uploaded: false, error: null },
  { type: 'drivers_license', labelKey: 'profile.license_photo', defaultLabel: 'Licencia de conducir', icon: 'id-card', uri: null, uploading: false, uploaded: false, error: null },
];

export default function EditVehicleScreen() {
  const { t } = useTranslation('driver');
  const { t: tc } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const driverId = useDriverStore((s) => s.profile?.id);

  // Vehicle fields
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [vehicleType, setVehicleType] = useState<VehicleType | null>(null);
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [color, setColor] = useState('');
  const [plateNumber, setPlateNumber] = useState('');
  const [capacity, setCapacity] = useState('');

  // Verification photos
  const [photos, setPhotos] = useState<PhotoDoc[]>(INITIAL_PHOTOS);

  // UI state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Load current vehicle data. Returns the vehicle id (or null).
  //
  // This used to swallow a failed getVehicle() and release the loading gate
  // anyway, leaving the whole form rendered with vehicleId=null. `handleSave`
  // opens with `if (!vehicleId … ) return`, so the driver could pick a type,
  // retype make/model/year/colour/plate/capacity, attach all three photos,
  // press Guardar — and get nothing. No toast, no spinner, no error: the
  // button was simply dead. On Cuban connections one failed GET was enough.
  //
  // Same bug the sibling screen already fixed and documented in
  // profile/cargo-settings.tsx; this one never got the treatment.
  const loadVehicle = useCallback(async (): Promise<string | null> => {
    if (!driverId) return null;
    try {
      const v = await driverService.getVehicle(driverId);
      if (v) {
        setVehicleId(v.id);
        setVehicleType(v.type);
        setMake(v.make);
        setModel(v.model);
        setYear(String(v.year));
        setColor(v.color);
        setPlateNumber(v.plate_number);
        setCapacity(String(v.capacity));
      }
      return v?.id ?? null;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => {
    void loadVehicle();
  }, [loadVehicle]);

  // ── Type selection ────────────────────────────────────────────────────────
  const handleTypeSelect = useCallback((config: typeof VEHICLE_CONFIGS[number]) => {
    setVehicleType(config.vehicleType);
    if (config.vehicleType === 'moto') {
      setCapacity('1');
    }
  }, []);

  // ── Photo picking ─────────────────────────────────────────────────────────
  // Shared tail of pickPhoto (compress + fill the slot) — also the re-entry
  // point for the recovery path after Android killed the app mid-capture.
  const applyPickedPhoto = useCallback(async (index: number, asset: ImagePicker.ImagePickerAsset) => {
    // Compress now (while the user is still looking at the picker) so
    // the subsequent save uploads a small file. Cuba connectivity:
    // 3 × 4 MB vehicle photos takes forever on edge/3G.
    const compressed = await compressDocument(asset.uri, asset.mimeType ?? 'image/jpeg');
    if (compressed.wasCompressed && compressed.originalBytes > 0) {
      Toast.show({
        type: 'info',
        text1: t('onboarding.document_compressed', { defaultValue: 'Imagen optimizada' }),
        text2: formatSizeDelta(compressed.originalBytes, compressed.compressedBytes),
        visibilityTime: 2000,
      });
    }
    setPhotos((prev) => prev.map((p, i) =>
      i === index ? { ...p, uri: compressed.uri, uploaded: false, error: null } : p,
    ));
  }, [t]);

  const pickPhoto = useCallback(async (index: number, source: 'camera' | 'gallery' = 'gallery') => {
    // Ask for the right permission first (Apple 2.1(a) — avoid the iOS
    // "Missing camera or camera roll permission" throw).
    const useCamera = source === 'camera' && Platform.OS !== 'web';
    if (!(await ensurePickerPermission(useCamera ? 'camera' : 'gallery', tc))) return;
    try {
      // Mark the launch so the relaunched app can recover the photo if the OS
      // kills our process while the camera/gallery is open (cameraRecovery.ts).
      await markPickerLaunch(RECOVERY_FLOW, { index: String(index) });
      const result = useCamera
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            quality: 0.7,
            allowsEditing: false,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 0.7,
            // Vehicle photos are rectangular — skip the forced OS square crop
            // (the crop window was too cramped to frame the whole vehicle).
            allowsEditing: false,
          });
      await clearPickerMarker(); // returned alive — no recovery needed

      if (result.canceled || !result.assets?.[0]) return;
      await applyPickedPhoto(index, result.assets[0]);
    } catch {
      Alert.alert('Error', tc('errors.generic'));
    }
  }, [tc, applyPickedPhoto]);

  // Recovery: if Android killed the app while the picker was open for one of
  // the 3 verification slots, restore the photo into its slot on remount.
  // consumeRecoveredPickerAsset is one-shot, so effect re-runs are no-ops.
  useEffect(() => {
    let cancelled = false;
    consumeRecoveredPickerAsset(RECOVERY_FLOW).then((rec) => {
      if (cancelled || !rec) return;
      const index = Number.parseInt(rec.meta.index ?? '', 10);
      if (!Number.isInteger(index) || index < 0 || index > 2) return;
      void applyPickedPhoto(index, rec.asset);
    });
    return () => { cancelled = true; };
  }, [applyPickedPhoto]);

  // Let the driver take the photo with the camera instead of the gallery. On many
  // Android phones the gallery is Google Photos, which fails to load on Cuba's
  // connection and shows "Se produjo un error, vuelve a intentarlo más tarde";
  // the camera bypasses it entirely.
  const choosePhotoSource = useCallback((index: number) => {
    Alert.alert(
      t('profile.vehicle_photo_label', { defaultValue: 'Foto del vehículo' }),
      t('onboarding.choose_photo_source', { defaultValue: '¿Cómo quieres agregar la foto?' }),
      [
        { text: t('onboarding.take_photo', { defaultValue: 'Tomar foto' }), onPress: () => pickPhoto(index, 'camera') },
        { text: t('onboarding.pick_from_gallery', { defaultValue: 'Seleccionar de galería' }), onPress: () => pickPhoto(index, 'gallery') },
        { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
      ],
    );
  }, [pickPhoto, t]);

  // ── Validation ────────────────────────────────────────────────────────────
  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!vehicleType) e.type = t('onboarding.error_vehicle_type_required', { defaultValue: 'Selecciona un tipo' });
    if (!make.trim()) e.make = t('onboarding.error_make_required', { defaultValue: 'Marca requerida' });
    if (!model.trim()) e.model = t('onboarding.error_model_required', { defaultValue: 'Modelo requerido' });
    const y = parseInt(year, 10);
    if (!y || y < 1990 || y > new Date().getFullYear()) e.year = t('onboarding.error_year_invalid', { defaultValue: 'Año inválido' });
    if (!color.trim()) e.color = t('onboarding.error_color_required', { defaultValue: 'Color requerido' });
    if (!isValidPlateNumber(plateNumber.trim().toUpperCase())) e.plate = t('onboarding.error_plate_invalid', { defaultValue: 'Placa inválida' });
    const c = parseInt(capacity, 10);
    const config = VEHICLE_CONFIGS.find((cfg) => cfg.vehicleType === vehicleType);
    const maxCap = config?.maxCapacity ?? 16;
    if (!c || c < 1 || c > maxCap) e.capacity = t('onboarding.error_capacity_invalid', { defaultValue: 'Capacidad inválida' });

    // Check all 3 photos
    const allPhotosSelected = photos.every((p) => p.uri);
    if (!allPhotosSelected) e.photos = t('profile.all_photos_required', { defaultValue: 'Debes subir las 3 fotos de verificación' });

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!driverId || !vehicleType) return;
    if (!validate()) return;

    // If the vehicle never loaded, retry once here rather than returning in
    // silence — otherwise the button looks dead. Mirrors cargo-settings.
    let vId = vehicleId;
    if (!vId) {
      vId = await loadVehicle();
      if (!vId) {
        Alert.alert(
          t('profile.vehicle_load_failed_title', { defaultValue: 'No se pudo cargar tu vehículo' }),
          t('profile.vehicle_load_failed_body', {
            defaultValue: 'Revisa tu conexión e inténtalo de nuevo. Si acabas de registrarte, espera la aprobación de tu vehículo.',
          }),
        );
        return;
      }
    }

    setSaving(true);
    try {
      // 1. Upload all verification photos
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i]!;
        if (!photo.uri) continue;

        setPhotos((prev) => prev.map((p, idx) =>
          idx === i ? { ...p, uploading: true } : p,
        ));

        try {
          const fileName = `${photo.type}-${Date.now()}.jpg`;
          await driverService.uploadDocument(driverId, photo.type, photo.uri, fileName);
          setPhotos((prev) => prev.map((p, idx) =>
            idx === i ? { ...p, uploading: false, uploaded: true } : p,
          ));
        } catch {
          setPhotos((prev) => prev.map((p, idx) =>
            idx === i ? { ...p, uploading: false, error: tc('errors.generic') } : p,
          ));
          setSaving(false);
          Alert.alert('Error', tc('errors.generic'));
          return;
        }
      }

      // 2. Update vehicle data
      await driverService.updateVehicle(vId, {
        type: vehicleType,
        make: make.trim(),
        model: model.trim(),
        year: parseInt(year, 10),
        color: color.trim(),
        plate_number: plateNumber.trim().toUpperCase(),
        capacity: parseInt(capacity, 10),
      });

      Alert.alert(
        '',
        t('profile.vehicle_update_success', { defaultValue: 'Vehículo actualizado. Pendiente de verificación.' }),
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch {
      Alert.alert('Error', tc('errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4">
        {/* Header */}
        <ProfileScreenHeader
          title={t('profile.edit_vehicle_title', { defaultValue: 'Editar vehículo' })}
          onBack={() => router.back()}
        />

        {loading ? (
          <View className="items-center py-20">
            <Text variant="body" color="primary" className="opacity-50">...</Text>
          </View>
        ) : (
          <>
            {/* ── Vehicle Type Selector ── */}
            <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
              <View className="flex-row items-center mb-3">
                <Ionicons name="car-sport" size={20} color={midnightEmber.accent[500]} />
                <Text variant="body" color="primary" className="ml-2 font-semibold">
                  {t('onboarding.vehicle_type', { defaultValue: 'Tipo de vehículo' })}
                </Text>
              </View>
              <View className="flex-row flex-wrap gap-3">
                {VEHICLE_CONFIGS.map((config) => {
                  const isSelected = vehicleType === config.vehicleType;
                  return (
                    <Pressable
                      key={config.vehicleType}
                      onPress={() => handleTypeSelect(config)}
                      style={{
                        width: '30%',
                        borderWidth: 2,
                        borderColor: isSelected ? config.accent : midnightEmber.screen.line.default,
                        borderRadius: 12,
                        backgroundColor: isSelected ? `${config.accent}15` : midnightEmber.screen.bg.canvas,
                        padding: 12,
                        alignItems: 'center',
                      }}
                    >
                      <Image
                        source={config.image}
                        style={{ width: 48, height: 48, marginBottom: 4 }}
                        resizeMode="contain"
                      />
                      <Text
                        variant="caption"
                        style={{ color: isSelected ? config.accent : midnightEmber.screen.text.primary, fontWeight: '700' }}
                      >
                        {config.label}
                      </Text>
                      {isSelected && (
                        <View style={{ position: 'absolute', top: 4, right: 4 }}>
                          <Ionicons name="checkmark-circle" size={16} color={config.accent} />
                        </View>
                      )}
                    </Pressable>
                  );
                })}
              </View>
              {errors.type ? (
                <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="mt-2">{errors.type}</Text>
              ) : null}
            </Card>

            {/* ── Vehicle Details ── */}
            <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
              <View className="flex-row items-center mb-3">
                <Ionicons name="information-circle" size={20} color="#3B82F6" />
                <Text variant="body" color="primary" className="ml-2 font-semibold">
                  {t('onboarding.step_vehicle', { defaultValue: 'Detalles del vehículo' })}
                </Text>
              </View>
              <Input
                label={t('onboarding.vehicle_make', { defaultValue: 'Marca' })}
                value={make}
                onChangeText={setMake}
                placeholder="Custom"
                variant="light"
              />
              {errors.make ? <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="-mt-2 mb-2">{errors.make}</Text> : null}

              <Input
                label={t('onboarding.vehicle_model', { defaultValue: 'Modelo' })}
                value={model}
                onChangeText={setModel}
                placeholder="Triciclo Eléctrico"
                variant="light"
              />
              {errors.model ? <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="-mt-2 mb-2">{errors.model}</Text> : null}

              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Input
                    label={t('onboarding.vehicle_year', { defaultValue: 'Año' })}
                    value={year}
                    onChangeText={setYear}
                    keyboardType="number-pad"
                    placeholder="2024"
                    variant="light"
                  />
                  {errors.year ? <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="-mt-2 mb-2">{errors.year}</Text> : null}
                </View>
                <View className="flex-1">
                  <Input
                    label={t('onboarding.vehicle_color', { defaultValue: 'Color' })}
                    value={color}
                    onChangeText={setColor}
                    placeholder="Azul"
                    variant="light"
                  />
                  {errors.color ? <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="-mt-2 mb-2">{errors.color}</Text> : null}
                </View>
              </View>

              <Input
                label={t('onboarding.plate_number', { defaultValue: 'Número de placa' })}
                value={plateNumber}
                onChangeText={setPlateNumber}
                autoCapitalize="characters"
                placeholder="P123456"
                variant="light"
              />
              {errors.plate ? <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="-mt-2 mb-2">{errors.plate}</Text> : null}

              <Input
                label={t('onboarding.max_passengers', { defaultValue: 'Capacidad de pasajeros' })}
                value={capacity}
                onChangeText={setCapacity}
                keyboardType="number-pad"
                placeholder="4"
                editable={vehicleType !== 'moto'}
                variant="light"
              />
              {errors.capacity ? <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="-mt-2 mb-2">{errors.capacity}</Text> : null}
            </Card>

            {/* ── Verification Photos ── */}
            <Card theme="light" variant="filled" padding="md" className="mb-6 bg-white">
              <View className="flex-row items-center mb-2">
                <Ionicons name="camera-outline" size={20} color={midnightEmber.accent[500]} />
                <Text variant="body" color="primary" className="ml-2 font-semibold">
                  {t('profile.verification_photos', { defaultValue: 'Fotos de verificación' })}
                </Text>
              </View>
              <Text variant="caption" color="primary" className="opacity-40 mb-4">
                {t('profile.verification_photos_desc', { defaultValue: 'Sube las fotos requeridas para verificar el cambio' })}
              </Text>

              {photos.map((photo, index) => (
                <Pressable
                  key={photo.type}
                  onPress={() => choosePhotoSource(index)}
                  className="flex-row items-center p-3 rounded-xl mb-3"
                  style={{ backgroundColor: midnightEmber.screen.bg.sunken }}
                >
                  {photo.uri ? (
                    <Image
                      source={{ uri: photo.uri }}
                      style={{ width: 48, height: 48, borderRadius: 8, marginRight: 12 }}
                      resizeMode="cover"
                    />
                  ) : (
                    <View className="w-12 h-12 rounded-lg items-center justify-center mr-3" style={{ backgroundColor: midnightEmber.screen.line.default }}>
                      <Ionicons name={photo.icon} size={20} color={midnightEmber.screen.text.tertiary} />
                    </View>
                  )}
                  <View className="flex-1">
                    <Text variant="body" color="primary">
                      {t(photo.labelKey, { defaultValue: photo.defaultLabel })}
                    </Text>
                    <Text variant="caption" color="primary" className="opacity-50">
                      {photo.uploading
                        ? '...'
                        : photo.uploaded
                          ? t('profile.photo_uploaded', { defaultValue: 'Foto subida' })
                          : photo.uri
                            ? t('profile.change_photo_label', { defaultValue: 'Cambiar' })
                            : t('profile.photo_required', { defaultValue: 'Foto requerida' })}
                    </Text>
                    {photo.error ? (
                      <Text variant="caption" style={{ color: midnightEmber.state.danger }}>{photo.error}</Text>
                    ) : null}
                  </View>
                  <Ionicons
                    name={photo.uri ? 'checkmark-circle' : 'add-circle-outline'}
                    size={24}
                    color={photo.uri ? midnightEmber.state.success : midnightEmber.screen.text.tertiary}
                  />
                </Pressable>
              ))}

              {errors.photos ? (
                <Text variant="caption" style={{ color: midnightEmber.state.danger }} className="mt-1">{errors.photos}</Text>
              ) : null}
            </Card>

            {/* Save */}
            <Button
              title={t('profile.cargo_save', { defaultValue: 'Guardar configuración' })}
              onPress={handleSave}
              loading={saving}
              fullWidth
              size="lg"
            />
          </>
        )}
      </View>
      </View>
    </Screen>
  );
}
