import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useRideStore } from '@/stores/ride.store';
import { colors } from '@tricigo/theme';

/**
 * Shown when a ride is completed but payment_status is still 'pending'.
 * Displays a generic "payment pending" message.
 *
 * The parent component (RideCompleteView) handles the Realtime
 * subscription that transitions away when payment_status changes.
 */
export function RidePaymentPending() {
  const { t } = useTranslation('rider');
  const activeRide = useRideStore((s) => s.activeRide);

  const fareCup = activeRide?.final_fare_cup ?? activeRide?.estimated_fare_cup ?? 0;

  if (!activeRide) return null;

  return (
    <View className="flex-1 pt-8 items-center">
      {/* Payment pending icon */}
      <View className="w-20 h-20 rounded-full bg-orange-100 items-center justify-center mb-4">
        <Text variant="h1">💳</Text>
      </View>

      <Text variant="h3" className="mb-2">
        {t('payment.pending_title', { defaultValue: 'Pago pendiente' })}
      </Text>
      <Text variant="body" color="secondary" className="mb-6 text-center px-4">
        {t('payment.pending_desc', { defaultValue: 'Completa el pago de tu viaje' })}
      </Text>

      {/* Amount card */}
      <Card variant="outlined" padding="lg" className="w-full mb-6">
        <Text variant="caption" color="secondary" className="text-center mb-1">
          {t('payment.amount', { defaultValue: 'Monto a pagar' })}
        </Text>
        <Text variant="h2" color="accent" className="text-center mb-1">
          {formatCUP(fareCup)}
        </Text>
      </Card>

      {/* Waiting indicator */}
      <View className="flex-row items-center gap-2 mt-2">
        <ActivityIndicator size="small" color={colors.neutral[400]} />
        <Text variant="caption" color="tertiary">
          {t('payment.waiting', { defaultValue: 'Esperando confirmacion...' })}
        </Text>
      </View>
    </View>
  );
}
