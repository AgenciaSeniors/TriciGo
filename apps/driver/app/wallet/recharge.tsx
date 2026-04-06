import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Pressable, Alert, ScrollView, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { Input } from '@tricigo/ui/Input';
import { useTranslation } from '@tricigo/i18n';
import { paymentService, walletService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';

const PRESET_AMOUNTS = [500, 1000, 2000, 5000];
const POLL_INTERVAL = 5000;
const MAX_POLL_TIME = 60000;

type Step = 'amount' | 'webview' | 'success';

export default function RechargeScreen() {
  const { t } = useTranslation('driver');
  const insets = useSafeAreaInsets();
  const userId = useAuthStore((s) => s.user?.id);

  const [step, setStep] = useState<Step>('amount');
  const [amount, setAmount] = useState('');
  const [customAmount, setCustomAmount] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [initialBalance, setInitialBalance] = useState(0);
  const [newBalance, setNewBalance] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef(0);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const selectedAmount = amount ? Number(amount) : Number(customAmount);

  const handleCreateLink = useCallback(async () => {
    if (!userId || selectedAmount <= 0) return;
    setCreating(true);
    try {
      // Save current balance for comparison
      const balanceData = await walletService.getBalance(userId);
      setInitialBalance(balanceData.available);

      // Create TropiPay link
      const result = await paymentService.createRechargeLink(userId, selectedAmount);
      setPaymentUrl(result.paymentUrl || result.shortUrl);
      setStep('webview');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error al crear enlace de pago';
      Alert.alert('Error', message);
    } finally {
      setCreating(false);
    }
  }, [userId, selectedAmount]);

  const startPolling = useCallback(() => {
    if (!userId) return;
    pollStartRef.current = Date.now();

    pollRef.current = setInterval(async () => {
      try {
        const balanceData = await walletService.getBalance(userId);
        if (balanceData.available > initialBalance) {
          // Balance increased — recharge successful
          if (pollRef.current) clearInterval(pollRef.current);
          setNewBalance(balanceData.available);
          setStep('success');
          return;
        }
        // Timeout after MAX_POLL_TIME
        if (Date.now() - pollStartRef.current > MAX_POLL_TIME) {
          if (pollRef.current) clearInterval(pollRef.current);
          Alert.alert(
            t('wallet.recharge_pending_title', { defaultValue: 'Pago pendiente' }),
            t('wallet.recharge_pending', { defaultValue: 'El pago aun no se ha confirmado. Si ya pagaste, tu saldo se actualizara en unos minutos.' }),
            [{ text: 'OK', onPress: () => router.back() }],
          );
        }
      } catch {
        // Silent — keep polling
      }
    }, POLL_INTERVAL);
  }, [userId, initialBalance, t]);

  const handleWebViewClose = useCallback(() => {
    // Start polling for balance changes
    startPolling();
  }, [startPolling]);

  return (
    <Screen bg="dark" statusBarStyle="light-content">
      {step === 'webview' ? (
        <View className="flex-1" style={{ paddingTop: insets.top }}>
          {/* WebView header */}
          <View className="flex-row items-center px-4 py-3" style={{ backgroundColor: '#1a1a2e' }}>
            <Pressable
              onPress={() => {
                setStep('amount');
                handleWebViewClose();
              }}
              className="w-11 h-11 rounded-xl items-center justify-center mr-3"
              style={{ backgroundColor: '#252540' }}
              accessibilityRole="button"
              accessibilityLabel={t('common.back', { defaultValue: 'Volver' })}
            >
              <Ionicons name="close" size={22} color="#fff" />
            </Pressable>
            <Text variant="body" color="inverse" className="font-semibold">
              TropiPay
            </Text>
          </View>
          <WebView
            source={{ uri: paymentUrl }}
            style={{ flex: 1, backgroundColor: '#0d0d1a' }}
            onNavigationStateChange={(navState) => {
              // Detect success/return URL patterns
              if (navState.url.includes('success') || navState.url.includes('return')) {
                startPolling();
              }
            }}
          />
        </View>
      ) : step === 'success' ? (
        <View className="flex-1 items-center justify-center px-6" style={{ paddingTop: insets.top }}>
          <View
            className="w-20 h-20 rounded-full items-center justify-center mb-6"
            style={{ backgroundColor: 'rgba(34,197,94,0.15)' }}
          >
            <Ionicons name="checkmark-circle" size={48} color={colors.success.DEFAULT} />
          </View>
          <Text variant="h2" color="inverse" className="mb-2 text-center">
            {t('wallet.recharge_success_title', { defaultValue: 'Recarga exitosa' })}
          </Text>
          <Text variant="body" color="secondary" className="mb-6 text-center">
            {t('wallet.recharge_success', {
              defaultValue: `Tu nuevo balance es ${formatCUP(newBalance)}.`,
              balance: formatCUP(newBalance),
            })}
          </Text>
          <Text variant="stat" color="accent" className="mb-8">
            {formatCUP(newBalance)}
          </Text>
          <Button
            title={t('common.done', { defaultValue: 'Listo' })}
            onPress={() => router.back()}
            size="lg"
            fullWidth
          />
        </View>
      ) : (
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
            {t('wallet.recharge_desc', { defaultValue: 'Selecciona o ingresa el monto que deseas recargar via TropiPay.' })}
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

          <Button
            title={creating ? t('wallet.processing', { defaultValue: 'Creando enlace...' }) : t('wallet.pay_with_tropipay', { defaultValue: 'Pagar con TropiPay' })}
            onPress={handleCreateLink}
            disabled={selectedAmount <= 0 || creating}
            loading={creating}
            size="lg"
            fullWidth
            className="mt-6"
          />
        </ScrollView>
      )}
    </Screen>
  );
}
