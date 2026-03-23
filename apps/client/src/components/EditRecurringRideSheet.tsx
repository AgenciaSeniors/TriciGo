import React, { useState, useCallback, useEffect } from 'react';
import { View, Pressable, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { recurringRideService } from '@tricigo/api';
import type { RecurringRide, ServiceTypeSlug, PaymentMethod } from '@tricigo/types';

interface EditRecurringRideSheetProps {
  ride: RecurringRide | null;
  visible: boolean;
  onClose: () => void;
  onUpdated: () => void;
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

function parseTimeOfDay(time: string): Date {
  const [h, m] = time.split(':').map(Number);
  return new Date(2000, 0, 1, h ?? 8, m ?? 0);
}

export function EditRecurringRideSheet({ ride, visible, onClose, onUpdated }: EditRecurringRideSheetProps) {
  const { t } = useTranslation('rider');

  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [time, setTime] = useState(new Date(2000, 0, 1, 8, 0));
  const [showTimePicker, setShowTimePicker] = useState(Platform.OS === 'ios');
  const [serviceType, setServiceType] = useState<ServiceTypeSlug>('triciclo_basico');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('tricicoin');
  const [saving, setSaving] = useState(false);

  // Pre-populate form when ride changes
  useEffect(() => {
    if (!ride) return;
    setSelectedDays([...ride.days_of_week]);
    setTime(parseTimeOfDay(ride.time_of_day));
    setServiceType(ride.service_type as ServiceTypeSlug);
    setPaymentMethod(ride.payment_method as PaymentMethod);
  }, [ride?.id]);

  const toggleDay = useCallback((day: number) => {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  }, []);

  const handleTimeChange = useCallback((_: any, selected?: Date) => {
    if (Platform.OS === 'android') setShowTimePicker(false);
    if (selected) setTime(selected);
  }, []);

  const canSave = selectedDays.length > 0 && ride;

  const handleSave = useCallback(async () => {
    if (!canSave || !ride) return;

    setSaving(true);
    try {
      const hours = time.getHours().toString().padStart(2, '0');
      const minutes = time.getMinutes().toString().padStart(2, '0');

      await recurringRideService.updateRecurringRide(ride.id, {
        days_of_week: selectedDays,
        time_of_day: `${hours}:${minutes}`,
        service_type: serviceType,
        payment_method: paymentMethod,
      });
      onUpdated();
    } catch {
      Alert.alert(t('common:error'), t('common:errors.recurring_rides_failed'));
    } finally {
      setSaving(false);
    }
  }, [canSave, ride, selectedDays, time, serviceType, paymentMethod, t, onUpdated]);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      {/* Header */}
      <Text variant="h4" className="mb-2">{t('recurring.edit', { defaultValue: 'Editar viaje recurrente' })}</Text>

      {/* Route (read-only) */}
      {ride && (
        <View className="mb-4 bg-neutral-50 rounded-xl p-3">
          <View className="flex-row items-center mb-1">
            <View className="w-2.5 h-2.5 rounded-full bg-primary-500 mr-2" />
            <Text variant="bodySmall" numberOfLines={1} className="flex-1">{ride.pickup_address}</Text>
          </View>
          <View className="flex-row items-center">
            <View className="w-2.5 h-2.5 rounded-full bg-neutral-400 mr-2" />
            <Text variant="bodySmall" color="secondary" numberOfLines={1} className="flex-1">{ride.dropoff_address}</Text>
          </View>
        </View>
      )}

      {/* Days of week */}
      <Text variant="label" className="mb-2">{t('recurring.days_label')}</Text>
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
        title={t('recurring.save_changes', { defaultValue: 'Guardar cambios' })}
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
