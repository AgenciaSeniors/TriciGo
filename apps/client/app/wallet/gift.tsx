import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, ScrollView, Share } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { colors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { referralService } from '@tricigo/api';
import { walletService } from '@tricigo/api/services/wallet';
import { formatTriciCoin, getErrorMessage, triggerHaptic } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';

type LookupMode = 'code' | 'phone';
type Recipient = { id: string; full_name: string };

/**
 * "Regalo" — send TriciCoin to another TriciGo user. Closed-loop:
 * the recipient must be an active user and the gifted balance is
 * spend-only (rides). Lookup by shareable code or by phone (no QR yet
 * — phase 2). Mirrors the wallet/referral screen style.
 */
export default function GiftScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);

  const [balance, setBalance] = useState(0);
  const [myCode, setMyCode] = useState('');

  const [mode, setMode] = useState<LookupMode>('code');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [recipient, setRecipient] = useState<Recipient | null>(null);

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      const [bal, code] = await Promise.all([
        walletService.getBalance(userId, 'customer_cash'),
        referralService.getOrCreateReferralCode(userId).catch(() => ''),
      ]);
      setBalance(bal.available);
      setMyCode(code);
    } catch {
      /* non-critical — balance defaults to 0, code hidden */
    }
  }, [userId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setRecipient(null);
    try {
      const found =
        mode === 'code'
          ? await walletService.findUserByGiftCode(q)
          : await walletService.findUserByPhone(q);
      if (!found) {
        Toast.show({ type: 'error', text1: t('gift.recipient_not_found', { defaultValue: 'Usuario no encontrado' }) });
        return;
      }
      if (found.id === userId) {
        Toast.show({ type: 'error', text1: t('gift.cannot_self', { defaultValue: 'No puedes regalarte a ti mismo' }) });
        return;
      }
      setRecipient({ id: found.id, full_name: found.full_name });
      triggerHaptic('light');
    } catch (err) {
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
    } finally {
      setSearching(false);
    }
  };

  const numericAmount = parseInt(amount, 10);
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0 && numericAmount <= balance;

  const handleSend = async () => {
    if (!userId || !recipient || !amountValid) return;
    setSubmitting(true);
    try {
      await walletService.sendGift(userId, recipient.id, numericAmount, note.trim() || undefined);
      triggerHaptic('light');
      Toast.show({
        type: 'success',
        text1: t('gift.success_title', { defaultValue: '¡Regalo enviado!' }),
        text2: t('gift.success_msg', {
          defaultValue: 'Le enviaste {{amount}} a {{name}}',
          amount: formatTriciCoin(numericAmount),
          name: recipient.full_name,
        }),
      });
      router.back();
    } catch (err) {
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyCode = async () => {
    if (!myCode) return;
    await Clipboard.setStringAsync(myCode);
    Toast.show({ type: 'success', text1: t('copied', { defaultValue: 'Copiado' }) });
    triggerHaptic('light');
  };

  const handleShareCode = async () => {
    if (!myCode) return;
    try {
      await Share.share({
        message: t('gift.share_code_message', {
          defaultValue: 'Envíame un regalo en TriciGo con mi código: {{code}}',
          code: myCode,
        }),
      });
    } catch {
      /* user cancelled share */
    }
  };

  return (
    <Screen bg="cuban" padded>
      <View className="pt-4 flex-1">
        <ScreenHeader title={t('gift.title', { defaultValue: 'Enviar regalo' })} onBack={() => router.back()} />

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {/* Balance */}
          <Card variant="filled" padding="md" className="mb-4 bg-primary-50 flex-row items-center justify-between">
            <Text variant="bodySmall" color="secondary">{t('gift.your_balance', { defaultValue: 'Tu saldo' })}</Text>
            <Text variant="h4" color="primary">{formatTriciCoin(balance)}</Text>
          </Card>

          {/* Recipient lookup */}
          {!recipient ? (
            <Card variant="outlined" padding="md" className="mb-4">
              <Text variant="body" className="font-semibold mb-3">
                {t('gift.find_recipient', { defaultValue: '¿A quién le regalas?' })}
              </Text>
              <View className="flex-row mb-3">
                <Pressable
                  onPress={() => { setMode('code'); setQuery(''); }}
                  className={`flex-1 py-2 rounded-l-lg items-center ${mode === 'code' ? 'bg-primary-500' : 'bg-gray-100'}`}
                >
                  <Text variant="bodySmall" style={{ color: mode === 'code' ? '#fff' : colors.neutral[600] }}>
                    {t('gift.by_code', { defaultValue: 'Código' })}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => { setMode('phone'); setQuery(''); }}
                  className={`flex-1 py-2 rounded-r-lg items-center ${mode === 'phone' ? 'bg-primary-500' : 'bg-gray-100'}`}
                >
                  <Text variant="bodySmall" style={{ color: mode === 'phone' ? '#fff' : colors.neutral[600] }}>
                    {t('gift.by_phone', { defaultValue: 'Teléfono' })}
                  </Text>
                </Pressable>
              </View>
              <Input
                placeholder={mode === 'code' ? t('gift.code_placeholder', { defaultValue: 'Código del amigo' }) : '+53XXXXXXXX'}
                value={query}
                onChangeText={setQuery}
                autoCapitalize={mode === 'code' ? 'characters' : 'none'}
                keyboardType={mode === 'phone' ? 'phone-pad' : 'default'}
              />
              <Button
                title={t('gift.search', { defaultValue: 'Buscar' })}
                variant="outline"
                size="md"
                fullWidth
                onPress={handleSearch}
                loading={searching}
                disabled={!query.trim() || searching}
                className="mt-2"
              />
            </Card>
          ) : (
            <Card variant="filled" padding="md" className="mb-4 flex-row items-center justify-between">
              <View className="flex-row items-center flex-1">
                <Ionicons name="person-circle-outline" size={36} color={colors.primary[500]} />
                <View className="ml-3 flex-1">
                  <Text variant="caption" color="tertiary">{t('gift.sending_to', { defaultValue: 'Le regalas a' })}</Text>
                  <Text variant="body" className="font-semibold" numberOfLines={1}>{recipient.full_name}</Text>
                </View>
              </View>
              <Pressable onPress={() => { setRecipient(null); setQuery(''); }}>
                <Text variant="bodySmall" color="primary">{t('gift.change', { defaultValue: 'Cambiar' })}</Text>
              </Pressable>
            </Card>
          )}

          {/* Amount + message */}
          {recipient ? (
            <Card variant="outlined" padding="md" className="mb-4">
              <Text variant="body" className="font-semibold mb-3">{t('gift.amount', { defaultValue: 'Monto del regalo' })}</Text>
              <Input
                placeholder="0"
                value={amount}
                onChangeText={(v) => setAmount(v.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
              />
              {amount.length > 0 && !amountValid ? (
                <Text variant="caption" style={{ color: colors.error.DEFAULT }} className="mt-1">
                  {numericAmount > balance
                    ? t('gift.insufficient', { defaultValue: 'Saldo insuficiente' })
                    : t('gift.invalid_amount', { defaultValue: 'Monto inválido' })}
                </Text>
              ) : null}

              <Text variant="body" className="font-semibold mb-2 mt-4">{t('gift.message_optional', { defaultValue: 'Mensaje (opcional)' })}</Text>
              <Input
                placeholder={t('gift.message_placeholder', { defaultValue: '¡Feliz cumple!' })}
                value={note}
                onChangeText={setNote}
                maxLength={200}
              />

              <Button
                title={t('gift.send', { defaultValue: 'Enviar regalo' })}
                variant="primary"
                size="lg"
                fullWidth
                onPress={handleSend}
                loading={submitting}
                disabled={!amountValid || submitting}
                className="mt-4"
              />
            </Card>
          ) : null}

          {/* My code to receive gifts */}
          <Card variant="filled" padding="lg" className="mb-6 mt-2 bg-primary-50 items-center">
            <Text variant="bodySmall" color="secondary" className="mb-2">
              {t('gift.my_code', { defaultValue: 'Tu código para recibir regalos' })}
            </Text>
            <Pressable onPress={handleCopyCode} className="flex-row items-center mb-3">
              <Text variant="h2" color="primary" className="tracking-widest">{myCode || '...'}</Text>
              {myCode ? (
                <Ionicons name="copy-outline" size={20} color={colors.primary[500]} style={{ marginLeft: 8 }} />
              ) : null}
            </Pressable>
            <Button
              title={t('gift.share_my_code', { defaultValue: 'Compartir mi código' })}
              variant="outline"
              size="md"
              onPress={handleShareCode}
              disabled={!myCode}
            />
          </Card>
        </ScrollView>
      </View>
    </Screen>
  );
}
