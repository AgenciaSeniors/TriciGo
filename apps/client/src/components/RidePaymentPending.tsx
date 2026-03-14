import React, { useEffect, useState, useCallback } from 'react';
import { View, Linking, ActivityIndicator } from 'react-native';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { paymentService } from '@tricigo/api';
import { useRideStore } from '@/stores/ride.store';
import { colors } from '@tricigo/theme';

/**
 * Shown when a ride is completed with payment_method='tropipay'
 * and payment_status='pending'. Provides a button to pay via TropiPay.
 *
 * The parent component (RideCompleteView) handles the Realtime
 * subscription that transitions away when payment_status changes.
 */
export function RidePaymentPending() {
  const { t } = useTranslation('rider');
  const activeRide = useRideStore((s) => s.activeRide);

  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [amountUsd, setAmountUsd] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const fareCup = activeRide?.final_fare_cup ?? activeRide?.estimated_fare_cup ?? 0;

  // Create or fetch payment link on mount
  useEffect(() => {
    if (!activeRide) return;
    let cancelled = false;

    async function createLink() {
      setCreating(true);
      try {
        const result = await paymentService.createRidePaymentLink(activeRide!.id);
        if (!cancelled) {
          setPaymentUrl(result.shortUrl || result.paymentUrl);
          setAmountUsd(result.amountUsd);
        }
      } catch (err) {
        console.error('[RidePaymentPending] Failed to create payment link:', err);
        if (!cancelled) {
          Toast.show({
            type: 'error',
            text1: t('common.error'),
            text2: err instanceof Error ? err.message : 'Error creating payment link',
          });
        }
      } finally {
        if (!cancelled) setCreating(false);
      }
    }

    createLink();
    return () => { cancelled = true; };
  }, [activeRide?.id]);

  const handlePayNow = useCallback(async () => {
    if (!paymentUrl) return;
    setLoading(true);
    try {
      await Linking.openURL(paymentUrl);
    } catch {
      Toast.show({
        type: 'error',
        text1: t('common.error'),
        text2: 'Could not open payment link',
      });
    } finally {
      setLoading(false);
    }
  }, [paymentUrl, t]);

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
        {amountUsd != null && (
          <Text variant="caption" color="tertiary" className="text-center">
            ~${amountUsd.toFixed(2)} USD
          </Text>
        )}
      </Card>

      {/* Pay button */}
      {creating ? (
        <View className="items-center py-4">
          <ActivityIndicator size="large" color={colors.brand.orange} />
          <Text variant="bodySmall" color="secondary" className="mt-2">
            {t('payment.creating_link', { defaultValue: 'Generando enlace de pago...' })}
          </Text>
        </View>
      ) : paymentUrl ? (
        <Button
          title={t('payment.pay_now', { defaultValue: 'Pagar ahora' })}
          size="lg"
          fullWidth
          onPress={handlePayNow}
          loading={loading}
          className="mb-4"
        />
      ) : (
        <Button
          title={t('payment.retry', { defaultValue: 'Reintentar' })}
          size="lg"
          fullWidth
          variant="outline"
          onPress={() => {
            // Re-trigger createLink by resetting state
            setCreating(true);
            paymentService.createRidePaymentLink(activeRide.id)
              .then((r) => {
                setPaymentUrl(r.shortUrl || r.paymentUrl);
                setAmountUsd(r.amountUsd);
              })
              .catch(() => {})
              .finally(() => setCreating(false));
          }}
          className="mb-4"
        />
      )}

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
