import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, Alert, Image, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { isValidPlateNumber } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';
import type { VehicleType, DocumentType } from '@tricigo/types';

// ── Vehicle type configs ──────────────────────────────────────────────────────
const VEHICLE_CONFIGS = [
  {
    vehicleType: 'triciclo' as VehicleType,
    label: 'Triciclo',
    defaultCapacity: 3,
    maxCapacity: 8,
    image: require('../../assets/vehicles/selection/triciclo.png'),
    accent: '#F97316',
  },
  {
    vehicleType: 'moto' as VehicleType,
    label: 'Moto',
    defaultCapacity: 1,
    maxCapacity: 1,
    image: require('../../assets/vehicles/selection/moto.png'),
    accent: '#3B82F6',
  },
  {
    vehicleType: 'auto' as VehicleType,
    label: 'Auto',
    defaultCapacity: 4,
    maxCapacity: 16,
    image: require('../../assets/vehicles/selection/auto.png'),
    accent: '#22C55E',
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

  // Load current vehicle data
  useEffect(() => {
    if (!driverId) return;
    driverService.getVehicle(driverId).then((v) => {
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
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [driverId]);

  // ── Type selection ────────────────────────────────────────────────────────
  const handleTypeSelect = useCallback((config: typeof VEHICLE_CONFIGS[number]) => {
    setVehicleType(config.vehicleType);
    if (config.vehicleType === 'moto') {
      setCapacity('1');
    }
  }, []);

  // ── Photo picking ─────────────────────────────────────────────────────────
  const pickPhoto = useCallback(async (index: number) => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.7,
        allowsEditing: true,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setPhotos((prev) => prev.map((p, i) =>
        i === index ? { ...p, uri: asset.uri, uploaded: false, error: null } : p,
      ));
    } catch {
      Alert.alert('Error', tc('errors.generic'));
    }
  }, [tc]);

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
    if (!vehicleId || !driverId || !vehicleType) return;
    if (!validate()) return;

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
      await driverService.updateVehicle(vehicleId, {
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
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        {/* Header */}
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#FAFAFA" />
          </Pressable>
          <Text variant="h3" color="inverse">
            {t('profile.edit_vehicle_title', { defaultValue: 'Editar vehículo' })}
          </Text>
        </View>

        {loading ? (
          <View className="items-center py-20">
            <Text variant="body" color="inverse" className="opacity-50">...</Text>
          </View>
        ) : (
          <>
            {/* ── Vehicle Type Selector ── */}
            <Card forceDark variant="filled" padding="md" className="mb-4 bg-neutral-800">
              <View className="flex-row items-center mb-3">
                <Ionicons name="car-sport" size={20} color={colors.brand.orange} />
                <Text variant="body" color="inverse" className="ml-2 font-semibold">
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
                        borderColor: isSelected ? config.accent : '#252540',
                        borderRadius: 12,
                        backgroundColor: isSelected ? `${config.accent}15` : '#1a1a2e',
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
                        style={{ color: isSelected ? config.accent : '#FFFFFF', fontWeight: '700' }}
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
                <Text variant="caption" className="text-red-400 mt-2">{errors.type}</Text>
              ) : null}
            </Card>

            {/* ── Vehicle Details ── */}
            <Card forceDark variant="filled" padding="md" className="mb-4 bg-neutral-800">
              <View className="flex-row items-center mb-3">
                <Ionicons name="information-circle" size={20} color="#3B82F6" />
                <Text variant="body" color="inverse" className="ml-2 font-semibold">
                  {t('onboarding.step_vehicle', { defaultValue: 'Detalles del vehículo' })}
                </Text>
              </View>
              <Input
                label={t('onboarding.vehicle_make', { defaultValue: 'Marca' })}
                value={make}
                onChangeText={setMake}
                placeholder="Custom"
                variant="dark"
              />
              {errors.make ? <Text variant="caption" className="text-red-400 -mt-2 mb-2">{errors.make}</Text> : null}

              <Input
                label={t('onboarding.vehicle_model', { defaultValue: 'Modelo' })}
                value={model}
                onChangeText={setModel}
                placeholder="Triciclo Eléctrico"
                variant="dark"
              />
              {errors.model ? <Text variant="caption" className="text-red-400 -mt-2 mb-2">{errors.model}</Text> : null}

              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Input
                    label={t('onboarding.vehicle_year', { defaultValue: 'Año' })}
                    value={year}
                    onChangeText={setYear}
                    keyboardType="number-pad"
                    placeholder="2024"
                    variant="dark"
                  />
                  {errors.year ? <Text variant="caption" className="text-red-400 -mt-2 mb-2">{errors.year}</Text> : null}
                </View>
                <View className="flex-1">
                  <Input
                    label={t('onboarding.vehicle_color', { defaultValue: 'Color' })}
                    value={color}
                    onChangeText={setColor}
                    placeholder="Azul"
                    variant="dark"
                  />
                  {errors.color ? <Text variant="caption" className="text-red-400 -mt-2 mb-2">{errors.color}</Text> : null}
                </View>
              </View>

              <Input
                label={t('onboarding.plate_number', { defaultValue: 'Número de placa' })}
                value={plateNumber}
                onChangeText={setPlateNumber}
                autoCapitalize="characters"
                placeholder="P123456"
                variant="dark"
              />
              {errors.plate ? <Text variant="caption" className="text-red-400 -mt-2 mb-2">{errors.plate}</Text> : null}

              <Input
                label={t('onboarding.max_passengers', { defaultValue: 'Capacidad de pasajeros' })}
                value={capacity}
                onChangeText={setCapacity}
                keyboardType="number-pad"
                placeholder="4"
                editable={vehicleType !== 'moto'}
                variant="dark"
              />
              {errors.capacity ? <Text variant="caption" className="text-red-400 -mt-2 mb-2">{errors.capacity}</Text> : null}
            </Card>

            {/* ── Verification Photos ── */}
            <Card forceDark variant="filled" padding="md" className="mb-6 bg-neutral-800">
              <View className="flex-row items-center mb-2">
                <Ionicons name="camera-outline" size={20} color={colors.brand.orange} />
                <Text variant="body" color="inverse" className="ml-2 font-semibold">
                  {t('profile.verification_photos', { defaultValue: 'Fotos de verificación' })}
                </Text>
              </View>
              <Text variant="caption" color="inverse" className="opacity-40 mb-4">
                {t('profile.verification_photos_desc', { defaultValue: 'Sube las fotos requeridas para verificar el cambio' })}
              </Text>

              {photos.map((photo, index) => (
                <Pressable
                  key={photo.type}
                  onPress={() => pickPhoto(index)}
                  className="flex-row items-center p-3 rounded-xl bg-neutral-700 mb-3"
                >
                  {photo.uri ? (
                    <Image
                      source={{ uri: photo.uri }}
                      style={{ width: 48, height: 48, borderRadius: 8, marginRight: 12 }}
                      resizeMode="cover"
                    />
                  ) : (
                    <View className="w-12 h-12 rounded-lg bg-neutral-600 items-center justify-center mr-3">
                      <Ionicons name={photo.icon} size={20} color="#A3A3A3" />
                    </View>
                  )}
                  <View className="flex-1">
                    <Text variant="body" color="inverse">
                      {t(photo.labelKey, { defaultValue: photo.defaultLabel })}
                    </Text>
                    <Text variant="caption" color="inverse" className="opacity-50">
                      {photo.uploading
                        ? '...'
                        : photo.uploaded
                          ? t('profile.photo_uploaded', { defaultValue: 'Foto subida' })
                          : photo.uri
                            ? t('profile.change_photo_label', { defaultValue: 'Cambiar' })
                            : t('profile.photo_required', { defaultValue: 'Foto requerida' })}
                    </Text>
                    {photo.error ? (
                      <Text variant="caption" className="text-red-400">{photo.error}</Text>
                    ) : null}
                  </View>
                  <Ionicons
                    name={photo.uri ? 'checkmark-circle' : 'add-circle-outline'}
                    size={24}
                    color={photo.uri ? '#22C55E' : '#A3A3A3'}
                  />
                </Pressable>
              ))}

              {errors.photos ? (
                <Text variant="caption" className="text-red-400 mt-1">{errors.photos}</Text>
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
    </Screen>
  );
}
