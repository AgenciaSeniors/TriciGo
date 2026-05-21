import React, { useState, useCallback } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { useTranslation } from '@tricigo/i18n';
import {
  formatCUP,
  getErrorMessage,
  logger,
  computeRechargeFeeUsd,
  computeRechargeChargeUsd,
  RECHARGE_LIMITS,
} from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { paymentService } from '@tricigo/api/services/payment';
import { useAuthStore } from '@/stores/auth.store';

// RECARGA V2: presets in USD. Driver-quota uses the same customer
// defaults (rounds 1-4). User picks NET amount; fee is additive 3%
// min $0.50; wallet credited in CUP at the FX rate of the day.
const PRESET_AMOUNTS_USD = [20, 50, 100, 200];
const MIN_RECHARGE_USD = RECHARGE_LIMITS.customer.min;
const MAX_RECHARGE_USD = RECHARGE_LIMITS.customer.max;

// Recharge now runs through NETOPIA's hosted payment page inside an in-app
// browser (WebBrowser.openAuthSessionAsync — same pattern as OAuth login).
// NETOPIA redirects back to RETURN_URL_BASE + ?intent=<id>, the in-app
// browser closes, and we poll the intent status natively. If iOS/Android
// stop honoring the universal link, swap to the custom scheme
// 'tricigo-driver://wallet'. See PROGRESS.md (2026-05-20 cutover).
const RETURN_URL_BASE = 'https://tricigo.com/app/driver/wallet';

export default function RechargeScreen() {
  const { t } = useTranslation('driver');
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);

  const [amount, setAmount] = useState('');
  const [customAmount, setCustomAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const selectedAmount = amount ? Number(amount) : Number(customAmount);

  const handleRecharge = useCallback(async () => {
    if (!user?.id || selectedAmount <= 0) return;
    if (selectedAmount < MIN_RECHARGE_USD || selectedAmount > MAX_RECHARGE_USD) {
      Toast.show({
        type: 'error',
        text1: t('wallet.invalid_amount', { defaultValue: 'Monto fuera de rango' }),
        text2: `${MIN_RECHARGE_USD}-${MAX_RECHARGE_USD} USD`,
      });
      return;
    }

    setSubmitting(true);
    try {
      // 1. Create the intent — edge function returns NETOPIA hosted page URL.
      // RECARGA V2: send the NET USD; server adds the 3% min $0.50 fee
      // and tells NETOPIA the full charge.
      const result = await paymentService.createRechargeIntent({
        provider: 'netopia',
        userId: user.id,
        amountUsd: selectedAmount,
        rechargeType: 'driver_quota',
        returnUrl: RETURN_URL_BASE,
      });
      if (!result.redirectUrl) {
        throw new Error(t('wallet.recharge_no_url', { defaultValue: 'El procesador no devolvió URL de pago' }));
      }

      // 2. Open the hosted page in an in-app browser. Bloquea hasta que
      //    NETOPIA redirija al dismissUrl, momento en que el sistema cierra
      //    el browser y nos devuelve aquí.
      const dismissUrl = `${RETURN_URL_BASE}?intent=${result.intentId}`;
      const browserResult = await WebBrowser.openAuthSessionAsync(
        result.redirectUrl,
        dismissUrl,
      );

      // 3. Branch on the result.
      if (browserResult.type === 'cancel' || browserResult.type === 'dismiss') {
        Toast.show({
          type: 'info',
          text1: t('wallet.recharge_cancelled', { defaultValue: 'Pago cancelado' }),
        });
        return;
      }

      // 4. browserResult.type === 'success' — poll the intent.
      Toast.show({
        type: 'info',
        text1: t('wallet.processing_recharge', { defaultValue: 'Procesando recarga...' }),
      });
      const final = await paymentService.pollIntentStatus(result.intentId, 20, 2000);
      if (final.status === 'completed') {
        Toast.show({
          type: 'success',
          text1: t('wallet.recharge_success', { defaultValue: '¡Recarga exitosa!' }),
          text2: `$${selectedAmount.toFixed(2)} USD`,
        });
        router.back();
      } else if (final.status === 'failed') {
        Toast.show({
          type: 'error',
          text1: t('wallet.recharge_failed', { defaultValue: 'El pago no se completó' }),
          text2: final.error_message ?? undefined,
        });
      } else {
        Toast.show({
          type: 'info',
          text1: t('wallet.recharge_pending', { defaultValue: 'Verificando tu pago…' }),
        });
      }
    } catch (err) {
      logger.error('netopia_driver_recharge_failed', { error: String(err) });
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }, [user?.id, selectedAmount, t]);

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

        {/* Preset amounts (USD) */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
          {PRESET_AMOUNTS_USD.map((preset) => {
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
                accessibilityLabel={`$${preset} USD`}
              >
                <Text
                  variant="metric"
                  style={{ color: isSelected ? colors.brand.orange : '#fff' }}
                >
                  ${preset}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Custom amount (USD) */}
        <Text variant="bodySmall" color="secondary" className="mb-2">
          {t('wallet.or_custom', { defaultValue: 'O ingresa un monto personalizado:' })}
        </Text>
        <Input
          label={t('wallet.custom_amount_usd', { defaultValue: 'Monto personalizado (USD)' })}
          placeholder="0"
          value={customAmount}
          onChangeText={(v) => { setCustomAmount(v); setAmount(''); }}
          keyboardType="numeric"
          variant="dark"
        />

        {/* Charge breakdown (additive fee) */}
        {selectedAmount > 0 && (() => {
          const fee = computeRechargeFeeUsd(selectedAmount);
          const charge = computeRechargeChargeUsd(selectedAmount).toFixed(2);
          return (
            <View style={{ backgroundColor: '#1a1a2e', borderRadius: 12, padding: 12, marginTop: 12 }}>
              <Text variant="caption" color="secondary">
                Pagarás ${charge} USD (incluye ${fee.toFixed(2)} de comisión de servicio)
              </Text>
            </View>
          );
        })()}

        {/* Closed-loop notice — recharge credits pay platform commissions only */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 8,
            backgroundColor: 'rgba(249,115,22,0.08)',
            borderWidth: 1,
            borderColor: 'rgba(249,115,22,0.25)',
            borderRadius: 12,
            padding: 12,
            marginTop: 12,
          }}
        >
          <Ionicons name="information-circle-outline" size={18} color={colors.brand.orange} />
          <Text variant="caption" color="secondary" style={{ flex: 1 }}>
            {t('wallet.recharge_non_refundable', {
              defaultValue: 'Estos créditos son no reembolsables y solo sirven para pagar comisiones de plataforma.',
            })}
          </Text>
        </View>

        <Button
          title={t('wallet.pay_with_card', { defaultValue: 'Pagar con tarjeta' })}
          onPress={handleRecharge}
          disabled={selectedAmount <= 0 || submitting || !user?.id}
          loading={submitting}
          size="lg"
          fullWidth
          className="mt-6"
        />

        <Text variant="caption" color="tertiary" className="mt-3 text-center">
          {t('wallet.recharge_inapp_hint', {
            defaultValue: 'Pagás de forma segura sin salir de la app.',
          })}
        </Text>
      </ScrollView>
    </Screen>
  );
}
