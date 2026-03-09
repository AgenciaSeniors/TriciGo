import React, { useEffect } from 'react';
import { View, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { formatCUP, HAVANA_PRESETS } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { useRideInit, useRideActions } from '@/hooks/useRide';
import { RideActiveView } from '@/components/RideActiveView';
import { RideCompleteView } from '@/components/RideCompleteView';
import type { GeoPoint, LocationPreset } from '@tricigo/utils';

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

  return (
    <View className="pt-4">
      <Text variant="h3" className="mb-1">
        {t('home.greeting', { name: user?.full_name ?? 'Viajero' })}
      </Text>

      <BalanceBadge balance={0} size="sm" className="mt-4 mb-6" />

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
      <Text variant="h4" className="mb-3">Servicios</Text>
      <View className="flex-row gap-3">
        {[
          { key: 'triciclo_basico', icon: '🛺' },
          { key: 'moto_standard', icon: '🏍️' },
          { key: 'auto_standard', icon: '🚗' },
        ].map((service) => (
          <Card
            key={service.key}
            variant="outlined"
            padding="md"
            className="flex-1 items-center"
          >
            <Text variant="h3" className="mb-1">{service.icon}</Text>
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
    setFlowStep,
    isLoading,
    error,
  } = useRideStore();
  const { requestEstimate } = useRideActions();

  const canEstimate = draft.pickup && draft.dropoff;

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
      {/* Back button */}
      <Pressable onPress={() => setFlowStep('idle')} className="mb-4">
        <Text variant="body" color="accent">← Volver</Text>
      </Pressable>

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
      <Text variant="label" className="mb-2">Servicio</Text>
      <View className="flex-row gap-3 mb-4">
        {(['triciclo_basico', 'moto_standard', 'auto_standard'] as const).map((st) => (
          <Pressable
            key={st}
            className={`flex-1 py-3 rounded-xl items-center ${
              draft.serviceType === st ? 'bg-primary-500' : 'bg-neutral-100'
            }`}
            onPress={() => setServiceType(st)}
          >
            <Text
              variant="caption"
              color={draft.serviceType === st ? 'inverse' : 'secondary'}
            >
              {t(`service_type.${st}` as const)}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Payment method */}
      <Text variant="label" className="mb-2">{t('ride.payment_method')}</Text>
      <View className="flex-row gap-3 mb-6">
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

      {error && (
        <Text variant="bodySmall" color="error" className="mb-4 text-center">
          {error}
        </Text>
      )}

      <Button
        title={t('ride.get_estimate', { defaultValue: 'Ver tarifa estimada' })}
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
  const { draft, fareEstimate, setFlowStep, isLoading, error } = useRideStore();
  const { confirmRide } = useRideActions();

  if (!fareEstimate) return null;

  const distanceKm = (fareEstimate.estimated_distance_m / 1000).toFixed(1);
  const durationMin = Math.round(fareEstimate.estimated_duration_s / 60);

  return (
    <View className="pt-4 flex-1">
      {/* Route summary */}
      <Card variant="outlined" padding="md" className="mb-4">
        <View className="flex-row items-start mb-3">
          <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
          <View className="flex-1">
            <Text variant="caption" color="secondary">{t('ride.pickup')}</Text>
            <Text variant="bodySmall">{draft.pickup?.address}</Text>
          </View>
        </View>
        <View className="flex-row items-start">
          <View className="w-3 h-3 rounded-full bg-neutral-800 mt-1 mr-3" />
          <View className="flex-1">
            <Text variant="caption" color="secondary">{t('ride.dropoff')}</Text>
            <Text variant="bodySmall">{draft.dropoff?.address}</Text>
          </View>
        </View>
      </Card>

      {/* Fare breakdown */}
      <Card variant="elevated" padding="lg" className="mb-6">
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

        <View className="h-px bg-neutral-200 my-3" />

        <View className="flex-row justify-between">
          <Text variant="h4">{t('ride.estimated_fare')}</Text>
          <Text variant="h3" color="accent">
            {formatCUP(fareEstimate.estimated_fare_cup)}
          </Text>
        </View>
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
        title="Volver"
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
  const { isLoading, error, activeRide } = useRideStore();
  const { cancelRide } = useRideActions();

  return (
    <View className="pt-8 flex-1 items-center">
      <StatusStepper
        steps={SEARCH_STEPS}
        currentStep="searching"
        className="w-full mb-8"
      />

      <ActivityIndicator size="large" color="#FF4D00" className="mb-4" />

      <Text variant="h4" className="mb-2 text-center">
        {t('ride.searching_driver')}
      </Text>
      <Text variant="bodySmall" color="secondary" className="mb-8 text-center">
        Esto puede tomar hasta 2 minutos
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
        onPress={() => cancelRide('Cancelado por el pasajero')}
        loading={isLoading}
      />
    </View>
  );
}
