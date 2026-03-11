import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, ActivityIndicator, ScrollView, Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { formatTRC, HAVANA_PRESETS } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { useRideInit, useRideActions } from '@/hooks/useRide';
import { RideActiveView } from '@/components/RideActiveView';
import { RideCompleteView } from '@/components/RideCompleteView';
import { RideMapView } from '@/components/RideMapView';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import type { GeoPoint, LocationPreset } from '@tricigo/utils';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { colors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';

const SEARCH_STEPS = [
  { key: 'searching', label: 'Buscando' },
  { key: 'accepted', label: 'Aceptado' },
  { key: 'driver_en_route', label: 'En camino' },
  { key: 'in_progress', label: 'En viaje' },
];

export default function HomeScreen() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);

  // Init ride state from DB
  useRideInit();

  const flowStep = useRideStore((s) => s.flowStep);

  return (
    <Screen bg="white" padded scroll>
      {flowStep === 'idle' && <IdleView />}
      {flowStep === 'selecting' && <SelectingView />}
      {flowStep === 'reviewing' && <ReviewingView />}
      {flowStep === 'searching' && <SearchingView />}
      {flowStep === 'active' && <RideActiveView />}
      {flowStep === 'completed' && <RideCompleteView />}
    </Screen>
  );
}

// ── Idle View ──────────────────────────────────────────────

function IdleView() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const setFlowStep = useRideStore((s) => s.setFlowStep);
  const [walletBalance, setWalletBalance] = useState(0);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        await walletService.ensureAccount(user.id);
        const bal = await walletService.getBalance(user.id);
        if (!cancelled) setWalletBalance(bal.available);
      } catch (err) { console.warn('[Home] Failed to load wallet:', err); }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  return (
    <View className="pt-4">
      <Text variant="h3" className="mb-1">
        {t('home.greeting', { name: user?.full_name ?? 'Viajero' })}
      </Text>

      <BalanceBadge balance={walletBalance} size="sm" className="mt-4 mb-6" />

      {/* Destination search */}
      <Pressable
        className="bg-neutral-100 rounded-xl px-4 py-4 flex-row items-center mb-6"
        onPress={() => setFlowStep('selecting')}
      >
        <View className="w-3 h-3 rounded-full bg-primary-500 mr-3" />
        <Text variant="body" color="tertiary">
          {t('home.where_to')}
        </Text>
      </Pressable>

      {/* Service types */}
      <Text variant="h4" className="mb-3">{t('home.services', { defaultValue: 'Servicios' })}</Text>
      <View className="flex-row gap-3">
        {[
          { key: 'triciclo_basico', icon: 'bicycle-outline' as const },
          { key: 'moto_standard', icon: 'flash-outline' as const },
          { key: 'auto_standard', icon: 'car-outline' as const },
        ].map((service) => (
          <Card
            key={service.key}
            variant="outlined"
            padding="md"
            className="flex-1 items-center"
          >
            <View className="w-10 h-10 rounded-full bg-primary-50 items-center justify-center mb-1">
              <Ionicons name={service.icon} size={22} color={colors.brand.orange} />
            </View>
            <Text variant="caption" color="secondary" className="text-center">
              {t(`service_type.${service.key}` as const)}
            </Text>
          </Card>
        ))}
      </View>
    </View>
  );
}

// ── Selecting View ─────────────────────────────────────────

function SelectingView() {
  const { t } = useTranslation('rider');
  const {
    draft,
    setPickup,
    setDropoff,
    setServiceType,
    setPaymentMethod,
    setScheduledAt,
    setDeliveryField,
    setFlowStep,
    isLoading,
    error,
  } = useRideStore();
  const { requestEstimate } = useRideActions();
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  const isDelivery = draft.serviceType === 'mensajeria';
  const deliveryValid = !isDelivery || (
    draft.delivery.packageDescription.trim() &&
    draft.delivery.recipientName.trim() &&
    draft.delivery.recipientPhone.trim()
  );
  const canEstimate = draft.pickup && draft.dropoff && deliveryValid;

  const minScheduleDate = new Date(Date.now() + 30 * 60 * 1000); // at least 30 min from now

  const selectPreset = (preset: LocationPreset, field: 'pickup' | 'dropoff') => {
    const loc: GeoPoint = { latitude: preset.latitude, longitude: preset.longitude };
    if (field === 'pickup') {
      setPickup(preset.address, loc);
    } else {
      setDropoff(preset.address, loc);
    }
  };

  return (
    <View className="pt-4">
      <ScreenHeader title={t('ride.select_route', { defaultValue: 'Seleccionar ruta' })} onBack={() => setFlowStep('idle')} />

      {/* Pickup */}
      <Text variant="label" className="mb-1">
        {t('ride.pickup')}
      </Text>
      <View className="bg-neutral-100 rounded-xl px-4 py-3 mb-2">
        <Text variant="body" color={draft.pickup ? 'primary' : 'tertiary'}>
          {draft.pickup?.address ?? t('ride.enter_pickup', { defaultValue: 'Punto de recogida' })}
        </Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4">
        <View className="flex-row gap-2">
          {HAVANA_PRESETS.map((p) => (
            <Pressable
              key={p.label}
              className={`px-3 py-1.5 rounded-full ${
                draft.pickup?.address === p.address
                  ? 'bg-primary-500'
                  : 'bg-neutral-100'
              }`}
              onPress={() => selectPreset(p, 'pickup')}
            >
              <Text
                variant="caption"
                color={draft.pickup?.address === p.address ? 'inverse' : 'secondary'}
              >
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {/* Dropoff */}
      <Text variant="label" className="mb-1">
        {t('ride.dropoff')}
      </Text>
      <View className="bg-neutral-100 rounded-xl px-4 py-3 mb-2">
        <Text variant="body" color={draft.dropoff ? 'primary' : 'tertiary'}>
          {draft.dropoff?.address ?? t('ride.enter_dropoff', { defaultValue: 'Destino' })}
        </Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-6">
        <View className="flex-row gap-2">
          {HAVANA_PRESETS.map((p) => (
            <Pressable
              key={p.label}
              className={`px-3 py-1.5 rounded-full ${
                draft.dropoff?.address === p.address
                  ? 'bg-primary-500'
                  : 'bg-neutral-100'
              }`}
              onPress={() => selectPreset(p, 'dropoff')}
            >
              <Text
                variant="caption"
                color={draft.dropoff?.address === p.address ? 'inverse' : 'secondary'}
              >
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {/* Service type */}
      <Text variant="label" className="mb-2">{t('ride.service_label', { defaultValue: 'Servicio' })}</Text>
      <View className="flex-row flex-wrap gap-3 mb-4">
        {([
          { key: 'triciclo_basico' as const, icon: 'bicycle-outline' as const },
          { key: 'moto_standard' as const, icon: 'flash-outline' as const },
          { key: 'auto_standard' as const, icon: 'car-outline' as const },
          { key: 'mensajeria' as const, icon: 'cube-outline' as const },
        ]).map((st) => (
          <Pressable
            key={st.key}
            className={`py-3 px-2 rounded-xl items-center ${
              draft.serviceType === st.key ? 'bg-primary-500' : 'bg-neutral-100'
            }`}
            style={{ width: '22%' }}
            onPress={() => setServiceType(st.key)}
          >
            <Ionicons
              name={st.icon}
              size={18}
              color={draft.serviceType === st.key ? '#fff' : colors.neutral[500]}
              style={{ marginBottom: 2 }}
            />
            <Text
              variant="caption"
              color={draft.serviceType === st.key ? 'inverse' : 'secondary'}
              className="text-center"
              style={{ fontSize: 10 }}
            >
              {t(`service_type.${st.key}` as const)}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Delivery fields (only when mensajeria is selected) */}
      {draft.serviceType === 'mensajeria' && (
        <Card variant="outlined" padding="md" className="mb-4">
          <Text variant="label" className="mb-3">
            {t('ride.delivery_details', { defaultValue: 'Detalles del envio' })}
          </Text>
          <Input
            placeholder={t('ride.package_description', { defaultValue: 'Descripcion del paquete' })}
            value={draft.delivery.packageDescription}
            onChangeText={(v) => setDeliveryField('packageDescription', v)}
            className="mb-3"
          />
          <Input
            placeholder={t('ride.recipient_name', { defaultValue: 'Nombre del destinatario' })}
            value={draft.delivery.recipientName}
            onChangeText={(v) => setDeliveryField('recipientName', v)}
            className="mb-3"
          />
          <Input
            placeholder={t('ride.recipient_phone', { defaultValue: 'Telefono del destinatario' })}
            value={draft.delivery.recipientPhone}
            onChangeText={(v) => setDeliveryField('recipientPhone', v)}
            keyboardType="phone-pad"
            className="mb-3"
          />
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Input
                placeholder={t('ride.estimated_weight', { defaultValue: 'Peso (kg)' })}
                value={draft.delivery.estimatedWeightKg}
                onChangeText={(v) => setDeliveryField('estimatedWeightKg', v)}
                keyboardType="numeric"
              />
            </View>
            <View className="flex-1">
              <Input
                placeholder={t('ride.special_instructions', { defaultValue: 'Instrucciones' })}
                value={draft.delivery.specialInstructions}
                onChangeText={(v) => setDeliveryField('specialInstructions', v)}
              />
            </View>
          </View>
        </Card>
      )}

      {/* Payment method */}
      <Text variant="label" className="mb-2">{t('ride.payment_method')}</Text>
      <View className="flex-row gap-3 mb-4">
        {(['cash', 'tricicoin'] as const).map((pm) => (
          <Pressable
            key={pm}
            className={`flex-1 py-3 rounded-xl items-center ${
              draft.paymentMethod === pm ? 'bg-primary-500' : 'bg-neutral-100'
            }`}
            onPress={() => setPaymentMethod(pm)}
          >
            <Text
              variant="caption"
              color={draft.paymentMethod === pm ? 'inverse' : 'secondary'}
            >
              {t(`payment.${pm}` as const)}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Schedule ride */}
      <View className="mb-6">
        <Pressable
          className={`flex-row items-center rounded-xl px-4 py-3 ${
            draft.scheduledAt ? 'bg-primary-50 border border-primary-500' : 'bg-neutral-100'
          }`}
          onPress={() => {
            if (draft.scheduledAt) {
              setScheduledAt(null);
            } else {
              setShowDatePicker(true);
            }
          }}
        >
          <Ionicons
            name="calendar-outline"
            size={20}
            color={draft.scheduledAt ? colors.brand.orange : colors.neutral[500]}
          />
          <Text
            variant="body"
            color={draft.scheduledAt ? 'accent' : 'secondary'}
            className="ml-3 flex-1"
          >
            {draft.scheduledAt
              ? `${draft.scheduledAt.toLocaleDateString('es-CU', { day: 'numeric', month: 'short' })} — ${draft.scheduledAt.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' })}`
              : t('ride.schedule_ride', { defaultValue: 'Programar viaje' })}
          </Text>
          {draft.scheduledAt && (
            <Ionicons name="close-circle" size={20} color={colors.neutral[400]} />
          )}
        </Pressable>
      </View>

      {/* Date picker */}
      {showDatePicker && (
        <DateTimePicker
          value={draft.scheduledAt ?? minScheduleDate}
          mode="date"
          minimumDate={minScheduleDate}
          onChange={(_e, date) => {
            setShowDatePicker(false);
            if (date) {
              const merged = draft.scheduledAt ? new Date(draft.scheduledAt) : new Date(date);
              merged.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
              setScheduledAt(merged);
              // On Android, show time picker right after date
              if (Platform.OS === 'android') {
                setTimeout(() => setShowTimePicker(true), 300);
              } else {
                setShowTimePicker(true);
              }
            }
          }}
        />
      )}

      {/* Time picker */}
      {showTimePicker && (
        <DateTimePicker
          value={draft.scheduledAt ?? minScheduleDate}
          mode="time"
          minimumDate={minScheduleDate}
          onChange={(_e, time) => {
            setShowTimePicker(false);
            if (time) {
              const merged = draft.scheduledAt ? new Date(draft.scheduledAt) : new Date(time);
              merged.setHours(time.getHours(), time.getMinutes());
              setScheduledAt(merged);
            }
          }}
        />
      )}

      {error && (
        <Text variant="bodySmall" color="error" className="mb-4 text-center">
          {error}
        </Text>
      )}

      <Button
        title={draft.scheduledAt
          ? t('ride.schedule_confirm', { defaultValue: 'Programar viaje' })
          : t('ride.get_estimate', { defaultValue: 'Ver tarifa estimada' })}
        size="lg"
        fullWidth
        onPress={requestEstimate}
        loading={isLoading}
        disabled={!canEstimate}
      />
    </View>
  );
}

// ── Reviewing View (BottomSheet) ───────────────────────────

function ReviewingView() {
  const { t } = useTranslation('rider');
  const { isTablet } = useResponsive();
  const { draft, fareEstimate, setFlowStep, isLoading, error, promoCode, promoResult, setPromoCode } = useRideStore();
  const { confirmRide, validatePromo, validatingPromo } = useRideActions();

  if (!fareEstimate) return null;

  const distanceKm = (fareEstimate.estimated_distance_m / 1000).toFixed(1);
  const durationMin = Math.round(fareEstimate.estimated_duration_s / 60);
  const discount = promoResult?.valid ? promoResult.discountAmount : 0;
  const finalFare = fareEstimate.estimated_fare_trc - discount;

  return (
    <View className="pt-4 flex-1">
      {/* Map preview */}
      <RideMapView
        pickupLocation={draft.pickup?.location ?? null}
        dropoffLocation={draft.dropoff?.location ?? null}
        height={isTablet ? 250 : 150}
      />
      <View className="h-3" />

      {/* Route summary */}
      <Card variant="outlined" padding="md" className="mb-4">
        <RouteSummary
          pickupAddress={draft.pickup?.address ?? ''}
          dropoffAddress={draft.dropoff?.address ?? ''}
          pickupLabel={t('ride.pickup')}
          dropoffLabel={t('ride.dropoff')}
        />
        {draft.scheduledAt && (
          <View className="flex-row items-center mt-3 pt-3 border-t border-neutral-200">
            <Ionicons name="calendar-outline" size={16} color={colors.brand.orange} />
            <Text variant="bodySmall" color="accent" className="ml-2">
              {t('ride.scheduled_for', { defaultValue: 'Programado' })}:{' '}
              {draft.scheduledAt.toLocaleDateString('es-CU', { day: 'numeric', month: 'short' })} — {draft.scheduledAt.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        )}
      </Card>

      {/* Fare breakdown */}
      <Card variant="elevated" padding="lg" className="mb-4">
        <Text variant="h4" className="mb-4">
          {t('ride.fare_breakdown', { defaultValue: 'Desglose de tarifa' })}
        </Text>

        <View className="flex-row justify-between mb-2">
          <Text variant="bodySmall" color="secondary">{t('ride.distance')}</Text>
          <Text variant="bodySmall">{distanceKm} km</Text>
        </View>
        <View className="flex-row justify-between mb-2">
          <Text variant="bodySmall" color="secondary">{t('ride.eta')}</Text>
          <Text variant="bodySmall">{durationMin} min</Text>
        </View>
        <View className="flex-row justify-between mb-2">
          <Text variant="bodySmall" color="secondary">
            {t(`service_type.${draft.serviceType}` as const)}
          </Text>
          <Text variant="bodySmall">
            {t(`payment.${draft.paymentMethod}` as const)}
          </Text>
        </View>

        {discount > 0 && (
          <View className="flex-row justify-between mb-2">
            <Text variant="bodySmall" className="text-green-600">{t('ride.discount', { defaultValue: 'Descuento' })}</Text>
            <Text variant="bodySmall" className="text-green-600">-{formatTRC(discount)}</Text>
          </View>
        )}

        <View className="h-px bg-neutral-200 my-3" />

        <View className="flex-row justify-between">
          <Text variant="h4">{t('ride.estimated_fare')}</Text>
          <Text variant="h3" color="accent">
            {formatTRC(finalFare)}
          </Text>
        </View>
      </Card>

      {/* Promo code */}
      <Card variant="outlined" padding="md" className="mb-6">
        <Text variant="label" className="mb-2">{t('ride.promo_code_label', { defaultValue: 'Código promocional' })}</Text>
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Input
              placeholder={t('ride.promo_code_label', { defaultValue: 'Ingresa tu código' })}
              value={promoCode}
              onChangeText={setPromoCode}
              autoCapitalize="characters"
            />
          </View>
          <Button
            title={t('ride.apply', { defaultValue: 'Aplicar' })}
            size="sm"
            variant="outline"
            onPress={validatePromo}
            loading={validatingPromo}
            disabled={!promoCode.trim()}
          />
        </View>
        {promoResult && (
          <Text
            variant="caption"
            color={promoResult.valid ? 'accent' : 'error'}
            className={promoResult.valid ? 'mt-2 text-green-600' : 'mt-2'}
          >
            {promoResult.valid
              ? t('ride.discount_applied', { defaultValue: `Descuento de ${formatTRC(promoResult.discountAmount)} aplicado`, amount: formatTRC(promoResult.discountAmount) })
              : promoResult.error ?? 'Código inválido'}
          </Text>
        )}
      </Card>

      {error && (
        <Text variant="bodySmall" color="error" className="mb-4 text-center">
          {error}
        </Text>
      )}

      <Button
        title={t('ride.confirm_ride', { defaultValue: 'Confirmar viaje' })}
        size="lg"
        fullWidth
        onPress={confirmRide}
        loading={isLoading}
        className="mb-3"
      />
      <Button
        title={t('home.back', { defaultValue: 'Volver' })}
        variant="ghost"
        size="lg"
        fullWidth
        onPress={() => setFlowStep('selecting')}
      />
    </View>
  );
}

// ── Searching View ─────────────────────────────────────────

function SearchingView() {
  const { t } = useTranslation('rider');
  const { isTablet } = useResponsive();
  const { isLoading, error, activeRide } = useRideStore();
  const { cancelRide } = useRideActions();

  return (
    <View className="pt-4 flex-1 items-center">
      {/* Map showing pickup + dropoff */}
      {activeRide && (
        <>
          <RideMapView
            pickupLocation={activeRide.pickup_location}
            dropoffLocation={activeRide.dropoff_location}
            height={isTablet ? 300 : 180}
          />
          <View className="h-4" />
        </>
      )}

      <StatusStepper
        steps={SEARCH_STEPS}
        currentStep="searching"
        className="w-full mb-8"
      />

      <ActivityIndicator size="large" color={colors.brand.orange} className="mb-4" />

      <Text variant="h4" className="mb-2 text-center">
        {t('ride.searching_driver')}
      </Text>
      <Text variant="bodySmall" color="secondary" className="mb-8 text-center">
        {t('ride.searching_wait', { defaultValue: 'Esto puede tomar hasta 2 minutos' })}
      </Text>

      {error && (
        <Text variant="bodySmall" color="error" className="mb-4 text-center">
          {error}
        </Text>
      )}

      <Button
        title={t('ride.cancel_ride')}
        variant="outline"
        size="lg"
        fullWidth
        onPress={() => cancelRide(t('ride.canceled_by_passenger', { defaultValue: 'Cancelado por el pasajero' }))}
        loading={isLoading}
      />
    </View>
  );
}
