import React, { useState, useCallback } from 'react';
import { View, Pressable, ScrollView, Linking } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  translateNetopiaError,
} from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { paymentService } from '@tricigo/api/services/payment';
import { walletService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useNetopiaCheckout } from '@/components/NetopiaCheckout';

// RECARGA V2: presets in USD. Driver-quota uses the same customer
// defaults (rounds 1-4). User picks NET amount; fee is additive 3%
// min $0.50; wallet credited in CUP at the FX rate of the day.
const PRESET_AMOUNTS_USD = [20, 50, 100, 200];
const MIN_RECHARGE_USD = RECHARGE_LIMITS.customer.min;
const MAX_RECHARGE_USD = RECHARGE_LIMITS.customer.max;

// Recharge runs through NETOPIA's hosted payment page inside the in-app
// NetopiaCheckout WebView (useNetopiaCheckout), routed through the VPS CONNECT
// proxy when `netopia_proxy_enabled` is on (so a reputation-flagged IP doesn't
// hit the Google Cloud Armor 403); else it falls back to
// WebBrowser.openAuthSessionAsync (the pre-existing flow). NETOPIA redirects
// back to RETURN_URL_BASE + ?intent=<id>; we poll the intent status natively.
// If iOS/Android stop honoring the universal link, swap to the custom scheme
// 'tricigo-driver://wallet'. See PROGRESS.md (2026-05-20 cutover).
const RETURN_URL_BASE = 'https://tricigo.com/app/driver/wallet';

export default function RechargeScreen() {
  const { t } = useTranslation('driver');
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  // NETOPIA card checkout: in-app WebView routed through the VPS CONNECT proxy
  // when enabled, else falls back to the system browser. See NetopiaCheckout.
  const { present: presentNetopiaCheckout, checkoutElement: netopiaCheckoutElement } =
    useNetopiaCheckout();

  const [amount, setAmount] = useState('');
  const [customAmount, setCustomAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // RECARGA V2 PARITY: success state. After NETOPIA returns and we've
  // polled the intent to `completed`, we stay on this screen and show
  // a "Ver recibo" chip once the PDF is generated (async post-webhook,
  // ~5-10s). Mirror of the web wallet success step.
  const [successView, setSuccessView] = useState<null | {
    chargeUsd: number;
    tcCredited: number;
  }>(null);
  const [successReceipt, setSuccessReceipt] = useState<null | {
    receipt_no: string;
    pdf_storage_path: string;
  }>(null);
  const [openingReceipt, setOpeningReceipt] = useState(false);

  const selectedAmount = amount ? Number(amount) : Number(customAmount);

  // RECARGA V2 PARITY: open the just-generated PDF via signed URL.
  const openSuccessReceipt = useCallback(async () => {
    if (!successReceipt) return;
    setOpeningReceipt(true);
    try {
      const url = await walletService.getReceiptSignedUrl(successReceipt.pdf_storage_path);
      await Linking.openURL(url);
    } catch (err) {
      logger.error('driver_receipt_open_failed', { error: String(err) });
      Toast.show({
        type: 'error',
        text1: t('wallet.receipt_open_failed', { defaultValue: 'No pudimos abrir el comprobante' }),
      });
    } finally {
      setOpeningReceipt(false);
    }
  }, [successReceipt, t]);

  const resetForm = useCallback(() => {
    setSuccessView(null);
    setSuccessReceipt(null);
    setAmount('');
    setCustomAmount('');
  }, []);

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
      // 00300: rechargeType='tricicoin' es el nombre canónico post-migración.
      // El backend acepta 'driver_quota' como alias legacy y lo rutea al
      // mismo lugar (account_type='tricicoin'), pero los clients nuevos
      // deberían mandar 'tricicoin' directamente.
      const result = await paymentService.createRechargeIntent({
        provider: 'netopia',
        userId: user.id,
        amountUsd: selectedAmount,
        rechargeType: 'tricicoin',
        returnUrl: RETURN_URL_BASE,
      });
      if (!result.redirectUrl) {
        throw new Error(t('wallet.recharge_no_url', { defaultValue: 'El procesador no devolvió URL de pago' }));
      }

      // 2. Open the hosted page in the in-app NETOPIA checkout WebView, routed
      //    through the VPS CONNECT proxy when enabled (else it falls back to
      //    WebBrowser — the exact pre-existing behavior). Resolves when NETOPIA
      //    redirects back to RETURN_URL_BASE (or the user closes the sheet).
      await presentNetopiaCheckout({
        url: result.redirectUrl,
        returnUrlBase: RETURN_URL_BASE,
        intentId: result.intentId,
        amountUsd: selectedAmount,
      });

      // 3. ALWAYS poll the intent — the browser dismissal `type` is NOT
      //    a reliable success/cancel signal:
      //      - `success` happens when the universal link bounces back
      //        to the app (best case).
      //      - `cancel`/`dismiss` happens when the user closes the
      //        browser MANUALLY, which is what happens whenever the
      //        universal link to `tricigo-driver://` fails to open the
      //        app (e.g. an APK without the right intentFilters, the
      //        assetlinks.json not resolving, system-browser quirks).
      //    In both cases NETOPIA may have already processed the IPN —
      //    the `payment_intents` row in the DB is the source of truth.
      //    See plan section "Bug 4" (rol-eres-un-auditor-immutable-platypus.md).
      Toast.show({
        type: 'info',
        text1: t('wallet.processing_recharge', { defaultValue: 'Verificando tu pago…' }),
      });
      const final = await paymentService.pollIntentStatus(result.intentId, 20, 2000);
      if (final.status === 'completed') {
        // RECARGA V2 PARITY: surface a success view with USD + TC and a
        // "Ver recibo" chip. The PDF is generated async post-webhook, so
        // we poll wallet_receipts for ~12s (6 attempts × 2s). If it
        // doesn't land in time, the driver can still download it later
        // from wallet/index.tsx (we cached the receipts map there).
        setSuccessView({
          chargeUsd: result.chargeUsd,
          tcCredited: result.amountCupCredited,
        });
        Toast.show({
          type: 'success',
          text1: t('wallet.recharge_success', { defaultValue: '¡Recarga exitosa!' }),
          text2: `$${selectedAmount.toFixed(2)} USD → +${result.amountCupCredited.toLocaleString('es-CU')} TC`,
        });

        // Fire-and-forget receipt poll. Stops as soon as the PDF row appears.
        void (async () => {
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const receipts = await walletService.getReceipts(user.id, 5);
              const found = receipts.find(
                (r) => r.payment_intent_id === result.intentId && r.pdf_storage_path,
              );
              if (found?.pdf_storage_path) {
                setSuccessReceipt({
                  receipt_no: found.receipt_no,
                  pdf_storage_path: found.pdf_storage_path,
                });
                return;
              }
            } catch {
              /* Non-fatal: chip just won't appear; user can download from history. */
            }
          }
        })();
      } else if (final.status === 'failed') {
        // Translate NETOPIA's English raw message (e.g. "Invalid CVV")
        // into Spanish copy that always tells the user their card was
        // NOT charged. See packages/utils/src/netopia-errors.ts.
        Toast.show({
          type: 'error',
          text1: t('wallet.recharge_failed', { defaultValue: 'El pago no se completó' }),
          text2: translateNetopiaError(final.error_message),
        });
      } else {
        // status='pending' / 'created' / 'processing' — webhook still in
        // flight (or user closed the browser before paying). Push will
        // cover the eventual outcome; show a soft "verifying" message.
        Toast.show({
          type: 'info',
          text1: t('wallet.recharge_pending', { defaultValue: 'Verificando tu pago…' }),
          text2: t('wallet.recharge_pending_hint', {
            defaultValue: 'Te avisaremos por notificación cuando termine.',
          }),
        });
      }
    } catch (err) {
      logger.error('netopia_driver_recharge_failed', { error: String(err) });
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }, [user?.id, selectedAmount, t]);

  // RECARGA V2 PARITY: render the success view once the intent settles.
  // The form is hidden until the driver explicitly resets to recargar
  // again or navigates back to the wallet list.
  if (successView) {
    return (
      <Screen bg="dark" statusBarStyle="light-content">
        <ScrollView
          contentContainerStyle={{
            paddingTop: insets.top + 8,
            paddingBottom: insets.bottom + 16,
            paddingHorizontal: 16,
          }}
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

          {/* Success card */}
          <View
            style={{
              backgroundColor: '#1a1a2e',
              borderRadius: 16,
              padding: 24,
              alignItems: 'center',
              marginTop: 24,
            }}
          >
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: 'rgba(22,163,74,0.15)',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <Ionicons name="checkmark-circle" size={40} color="#16A34A" />
            </View>
            <Text variant="h3" color="inverse" style={{ marginBottom: 8 }}>
              {t('wallet.recharge_success', { defaultValue: '¡Recarga exitosa!' })}
            </Text>
            <Text variant="body" color="secondary" style={{ textAlign: 'center', marginBottom: 4 }}>
              ${successView.chargeUsd.toFixed(2)} USD
            </Text>
            <Text
              variant="metric"
              style={{ color: colors.brand.orange, marginBottom: 4 }}
            >
              +{successView.tcCredited.toLocaleString('es-CU')} TC
            </Text>
            <Text variant="caption" color="tertiary" style={{ textAlign: 'center' }}>
              {t('wallet.recharge_success_hint', {
                defaultValue: 'Tu crédito de comisión se actualizó.',
              })}
            </Text>
          </View>

          {/* Receipt chip — appears once the PDF is ready (5-10s post-webhook) */}
          {successReceipt ? (
            <Pressable
              onPress={openSuccessReceipt}
              disabled={openingReceipt}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  paddingVertical: 14,
                  paddingHorizontal: 20,
                  backgroundColor: 'rgba(249,115,22,0.12)',
                  borderWidth: 1,
                  borderColor: 'rgba(249,115,22,0.35)',
                  borderRadius: 12,
                  marginTop: 16,
                },
                pressed && { opacity: 0.7 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('wallet.download_receipt_aria', {
                defaultValue: 'Descargar comprobante {{no}}',
                no: successReceipt.receipt_no,
              })}
            >
              <Ionicons name="document-text-outline" size={18} color={colors.brand.orange} />
              <Text variant="body" style={{ color: colors.brand.orange, fontWeight: '600' }}>
                {openingReceipt
                  ? t('wallet.opening_receipt', { defaultValue: 'Abriendo…' })
                  : t('wallet.view_receipt', { defaultValue: 'Ver recibo' })}{' '}
                {successReceipt.receipt_no}
              </Text>
            </Pressable>
          ) : (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                paddingVertical: 14,
                marginTop: 16,
              }}
            >
              <Text variant="caption" color="tertiary">
                {t('wallet.receipt_generating', {
                  defaultValue: 'Generando comprobante PDF…',
                })}
              </Text>
            </View>
          )}

          <Button
            title={t('wallet.recharge_another', { defaultValue: 'Hacer otra recarga' })}
            onPress={resetForm}
            variant="ghost"
            size="lg"
            fullWidth
            className="mt-4"
          />
          <Button
            title={t('common.back_to_wallet', { defaultValue: 'Volver a mi cuenta' })}
            onPress={() => router.back()}
            size="lg"
            fullWidth
            className="mt-2"
          />
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen bg="dark" statusBarStyle="light-content">
      {netopiaCheckoutElement}
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
