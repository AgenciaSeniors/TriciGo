import React, { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP, logger, getErrorMessage } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { paymentService } from '@tricigo/api/services/payment';
import { useAuthStore } from '@/stores/auth.store';
import { initPaymentSheet, presentPaymentSheet } from '@stripe/stripe-react-native';
import Toast from 'react-native-toast-message';

const PRESET_AMOUNTS = [500, 1000, 2000, 5000];

export default function RechargeScreen() {
  const { t } = useTranslation('driver');
  const insets = useSafeAreaInsets();
  const userId = useAuthStore((s) => s.user?.id);

  const [amount, setAmount] = useState('');
  const [customAmount, setCustomAmount] = useState('');
  const [processing, setProcessing] = useState(false);

  const selectedAmount = amount ? Number(amount) : Number(customAmount);

  const handleRecharge = async () => {
    if (!userId || selectedAmount <= 0) return;

    setProcessing(true);
    try {
      // 1. Create Stripe PaymentIntent for driver quota recharge
      const result = await paymentService.createStripePaymentIntent(
        userId,
        selectedAmount,
        'driver_quota',
      );

      // 2. Initialize payment sheet
      const { error: initError } = await initPaymentSheet({
        paymentIntentClientSecret: result.clientSecret,
        merchantDisplayName: 'TriciGo',
        style: 'automatic',
        returnURL: 'tricigo-driver://wallet?recharge=success',
      });

      if (initError) {
        logger.error('Driver Stripe initPaymentSheet error', { error: initError.message });
        Toast.show({ type: 'error', text1: initError.message });
        return;
      }

      // 3. Present the payment sheet
      const { error: presentError } = await presentPaymentSheet();

      if (presentError) {
        if (presentError.code === 'Canceled') {
          Toast.show({ type: 'info', text1: t('wallet.recharge_cancelled', { defaultValue: 'Recarga cancelada' }) });
          return;
        }
        logger.error('Driver Stripe presentPaymentSheet error', { error: presentError.message });
        Toast.show({ type: 'error', text1: presentError.message });
        return;
      }

      // 4. Payment succeeded — poll for wallet credit
      Toast.show({ type: 'info', text1: t('wallet.recharge_processing', { defaultValue: 'Procesando recarga...' }) });

      const finalIntent = await paymentService.pollIntentStatus(result.intentId, 15, 2000);
      if (finalIntent.status === 'completed') {
        Toast.show({ type: 'success', text1: t('wallet.recharge_success', { defaultValue: 'Recarga exitosa' }) });
        router.back();
      } else if (finalIntent.status === 'failed') {
        Toast.show({ type: 'error', text1: finalIntent.error_message ?? t('errors.recharge_failed', { defaultValue: 'Error en la recarga' }) });
      } else {
        // Still processing
        Toast.show({ type: 'success', text1: t('wallet.recharge_success', { defaultValue: 'Recarga exitosa' }) });
        router.back();
      }
    } catch (err) {
      logger.error('Error processing driver Stripe recharge', { error: String(err) });
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <Screen bg="dark" statusBarStyle="light-content">
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16, paddingHorizontal: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            className="w-11 h-11 rounded-xl items-center justify-center mr-3"
            style={{ backgroundColor: '#252540' }}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', { defaultValue: 'Volver' })}
          >
            <Ionicons name="arrow-back" size={20} color="#fff" />
          </Pressable>
          <Text variant="h2" color="inverse">
            {t('wallet.recharge', { defaultValue: 'Recargar' })}
          </Text>
        </View>

        <Text variant="body" color="secondary" className="mb-6">
          {t('wallet.recharge_desc', { defaultValue: 'Selecciona o ingresa el monto que deseas recargar.' })}
        </Text>

        {/* Preset amounts */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
          {PRESET_AMOUNTS.map((preset) => {
            const isSelected = amount === String(preset);
            return (
              <Pressable
                key={preset}
                onPress={() => { setAmount(String(preset)); setCustomAmount(''); }}
                style={({ pressed }) => [
                  {
                    flex: 1,
                    minWidth: '45%',
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingVertical: 16,
                    backgroundColor: isSelected ? 'rgba(249,115,22,0.15)' : '#1a1a2e',
                    borderWidth: isSelected ? 2 : 1.5,
                    borderColor: isSelected ? colors.brand.orange : 'rgba(255,255,255,0.15)',
                    borderRadius: 16,
                    minHeight: 60,
                  },
                  pressed && { transform: [{ scale: 0.97 }] },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${formatCUP(preset)}`}
              >
                <Text
                  variant="metric"
                  style={{ color: isSelected ? colors.brand.orange : '#fff' }}
                >
                  {formatCUP(preset)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Custom amount */}
        <Text variant="bodySmall" color="secondary" className="mb-2">
          {t('wallet.or_custom', { defaultValue: 'O ingresa un monto personalizado:' })}
        </Text>
        <Input
          label={t('wallet.custom_amount', { defaultValue: 'Monto personalizado (CUP)' })}
          placeholder="0"
          value={customAmount}
          onChangeText={(v) => { setCustomAmount(v); setAmount(''); }}
          keyboardType="numeric"
          variant="dark"
        />

        {/* Fee info */}
        {selectedAmount > 0 && (
          <View style={{ backgroundColor: '#1a1a2e', borderRadius: 12, padding: 12, marginTop: 12 }}>
            <Text variant="caption" color="secondary">
              ≈ ${(selectedAmount / 520).toFixed(2)} USD + $2.00 fee = ${((selectedAmount / 520) + 2).toFixed(2)} USD total
            </Text>
          </View>
        )}

        <Button
          title={processing ? t('wallet.processing', { defaultValue: 'Procesando...' }) : t('wallet.pay_with_card', { defaultValue: 'Pagar con tarjeta' })}
          onPress={handleRecharge}
          disabled={selectedAmount <= 0 || processing}
          loading={processing}
          size="lg"
          fullWidth
          className="mt-6"
        />
      </ScrollView>
    </Screen>
  );
}
