import React, { useState, useCallback } from 'react';
import { View, Pressable, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { recurringRideService } from '@tricigo/api';
import type { ServiceTypeSlug, PaymentMethod } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';
import { AddressSearchInput } from '@/components/AddressSearchInput';
import type { GeoPoint } from '@tricigo/utils';

interface CreateRecurringRideSheetProps {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const DAY_KEYS = ['day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat', 'day_sun'] as const;

const SERVICE_TYPES: { slug: ServiceTypeSlug; icon: string }[] = [
  { slug: 'triciclo_basico', icon: 'bicycle-outline' },
  { slug: 'moto_standard', icon: 'flash-outline' },
  { slug: 'auto_standard', icon: 'car-outline' },
];

const PAYMENT_METHODS: { key: PaymentMethod; icon: string }[] = [
  { key: 'tricicoin', icon: 'wallet-outline' },
  { key: 'cash', icon: 'cash-outline' },
];

export function CreateRecurringRideSheet({ visible, onClose, onCreated }: CreateRecurringRideSheetProps) {
  const { t } = useTranslation('rider');
  const userId = useAuthStore((s) => s.user?.id);

  const [pickupAddress, setPickupAddress] = useState('');
  const [pickupLocation, setPickupLocation] = useState<GeoPoint | null>(null);
  const [dropoffAddress, setDropoffAddress] = useState('');
  const [dropoffLocation, setDropoffLocation] = useState<GeoPoint | null>(null);
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [time, setTime] = useState(new Date(2000, 0, 1, 8, 0));
  const [showTimePicker, setShowTimePicker] = useState(Platform.OS === 'ios');
  const [serviceType, setServiceType] = useState<ServiceTypeSlug>('triciclo_basico');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('tricicoin');
  const [saving, setSaving] = useState(false);

  const toggleDay = useCallback((day: number) => {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  }, []);

  const handleTimeChange = useCallback((_: any, selected?: Date) => {
    if (Platform.OS === 'android') setShowTimePicker(false);
    if (selected) setTime(selected);
  }, []);

  const handlePickupSelect = useCallback((address: string, location: GeoPoint) => {
    setPickupAddress(address);
    setPickupLocation(location);
  }, []);

  const handleDropoffSelect = useCallback((address: string, location: GeoPoint) => {
    setDropoffAddress(address);
    setDropoffLocation(location);
  }, []);

  const resetForm = useCallback(() => {
    setPickupAddress('');
    setPickupLocation(null);
    setDropoffAddress('');
    setDropoffLocation(null);
    setSelectedDays([]);
    setTime(new Date(2000, 0, 1, 8, 0));
    setServiceType('triciclo_basico');
    setPaymentMethod('tricicoin');
  }, []);

  const canSave =
    pickupLocation && dropoffLocation && selectedDays.length > 0 && userId;

  const handleSave = useCallback(async () => {
    if (!canSave || !pickupLocation || !dropoffLocation || !userId) return;

    setSaving(true);
    try {
      const hours = time.getHours().toString().padStart(2, '0');
      const minutes = time.getMinutes().toString().padStart(2, '0');

      await recurringRideService.createRecurringRide({
        user_id: userId,
        pickup_latitude: pickupLocation.latitude,
        pickup_longitude: pickupLocation.longitude,
        pickup_address: pickupAddress,
        dropoff_latitude: dropoffLocation.latitude,
        dropoff_longitude: dropoffLocation.longitude,
        dropoff_address: dropoffAddress,
        service_type: serviceType,
        payment_method: paymentMethod,
        days_of_week: selectedDays,
        time_of_day: `${hours}:${minutes}`,
        timezone: 'America/Havana',
      });
      resetForm();
      onCreated();
    } catch (err: any) {
      const msg = err?.message?.includes('max')
        ? t('recurring.max_reached')
        : t('common:errors.generic');
      Alert.alert(t('common:error'), msg);
    } finally {
      setSaving(false);
    }
  }, [canSave, pickupLocation, dropoffLocation, pickupAddress, dropoffAddress, serviceType, paymentMethod, selectedDays, time, userId, t, resetForm, onCreated]);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      {/* Header */}
      <Text variant="h4" className="mb-4">{t('recurring.create')}</Text>

      {/* Route */}
      <Text variant="label" className="mb-2">{t('recurring.route_label')}</Text>
      <AddressSearchInput
        placeholder={t('ride.pickup_placeholder', { defaultValue: '¿Dónde te recogemos?' })}
        selectedAddress={pickupAddress || null}
        onSelect={handlePickupSelect}
        showUseMyLocation
      />
      <AddressSearchInput
        placeholder={t('ride.dropoff_placeholder', { defaultValue: '¿A dónde vas?' })}
        selectedAddress={dropoffAddress || null}
        onSelect={handleDropoffSelect}
      />

      {/* Days of week */}
      <Text variant="label" className="mb-2 mt-3">{t('recurring.days_label')}</Text>
      <View className="flex-row gap-1.5 mb-4">
        {[1, 2, 3, 4, 5, 6, 7].map((day) => {
          const isActive = selectedDays.includes(day);
          return (
            <Pressable
              key={day}
              onPress={() => toggleDay(day)}
              className={`w-9 h-9 rounded-full items-center justify-center ${
                isActive ? 'bg-primary-500' : 'bg-neutral-100'
              }`}
            >
              <Text className={`text-sm font-semibold ${isActive ? 'text-white' : 'text-neutral-500'}`}>
                {t(`recurring.${DAY_KEYS[day - 1]}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Time picker */}
      <Text variant="label" className="mb-2">{t('recurring.time_label')}</Text>
      {Platform.OS === 'android' && !showTimePicker && (
        <Pressable
          onPress={() => setShowTimePicker(true)}
          className="bg-neutral-100 rounded-xl px-4 py-3 flex-row items-center mb-4"
        >
          <Ionicons name="time-outline" size={18} color={colors.neutral[500]} />
          <Text variant="body" className="ml-2">
            {time.getHours().toString().padStart(2, '0')}:{time.getMinutes().toString().padStart(2, '0')}
          </Text>
        </Pressable>
      )}
      {showTimePicker && (
        <View className="mb-4">
          <DateTimePicker
            value={time}
            mode="time"
            is24Hour
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={handleTimeChange}
          />
        </View>
      )}

      {/* Service type */}
      <Text variant="label" className="mb-2">{t('recurring.service_label')}</Text>
      <View className="flex-row gap-2 mb-4">
        {SERVICE_TYPES.map(({ slug, icon }) => (
          <Pressable
            key={slug}
            onPress={() => setServiceType(slug)}
            className={`flex-1 flex-row items-center justify-center py-2.5 rounded-xl border ${
              serviceType === slug ? 'bg-primary-50 border-primary-500' : 'bg-neutral-50 border-neutral-200'
            }`}
          >
            <Ionicons
              name={icon as any}
              size={18}
              color={serviceType === slug ? colors.primary[500] : colors.neutral[500]}
            />
            <Text
              variant="caption"
              className={`ml-1.5 font-medium ${serviceType === slug ? 'text-primary-600' : 'text-neutral-600'}`}
            >
              {t(`service_type.${slug}` as any, { defaultValue: slug })}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Payment method */}
      <Text variant="label" className="mb-2">{t('recurring.payment_label')}</Text>
      <View className="flex-row gap-2 mb-6">
        {PAYMENT_METHODS.map(({ key, icon }) => (
          <Pressable
            key={key}
            onPress={() => setPaymentMethod(key)}
            className={`flex-1 flex-row items-center justify-center py-2.5 rounded-xl border ${
              paymentMethod === key ? 'bg-primary-50 border-primary-500' : 'bg-neutral-50 border-neutral-200'
            }`}
          >
            <Ionicons
              name={icon as any}
              size={18}
              color={paymentMethod === key ? colors.primary[500] : colors.neutral[500]}
            />
            <Text
              variant="caption"
              className={`ml-1.5 font-medium ${paymentMethod === key ? 'text-primary-600' : 'text-neutral-600'}`}
            >
              {key === 'tricicoin' ? 'TriciCoin' : t('common:profile.payment_cash')}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Save button */}
      <Button
        title={t('recurring.save')}
        size="lg"
        fullWidth
        onPress={handleSave}
        loading={saving}
        disabled={!canSave || saving}
        className="mb-2"
      />
      <Button
        title={t('common:cancel')}
        variant="outline"
        size="lg"
        fullWidth
        onPress={onClose}
        disabled={saving}
      />
    </BottomSheet>
  );
}
