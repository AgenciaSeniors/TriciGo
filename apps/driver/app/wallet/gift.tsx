import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Pressable, ScrollView, Share, useColorScheme, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { colors, cubanLight, cubanDark } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { referralService } from '@tricigo/api';
import { walletService } from '@tricigo/api/services/wallet';
import { formatCUP, getErrorMessage, triggerHaptic, newGiftIdempotencyKey } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { GiftQrScanner } from '@/components/GiftQrScanner';

// QR generation is native-only (uses react-native-svg). On web we fall
// back to the text code + copy/share.
let QRCode: React.ComponentType<{ value: string; size?: number }> | null = null;
if (Platform.OS !== 'web') {
  try { QRCode = require('react-native-qrcode-svg').default; } catch { QRCode = null; }
}

type LookupMode = 'code' | 'phone';
type Recipient = { id: string; full_name: string };

/**
 * "Regalo" — driver-side gift screen. A driver gifts from their
 * tricicoin balance (resolved server-side by send_gift). Mirrors the
 * client gift screen; styled with the driver app's cuban palette +
 * shared UI components (same as the driver referral screen).
 */
export default function DriverGiftScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const isDark = useColorScheme() === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const { code: codeParam } = useLocalSearchParams<{ code?: string }>();

  const [balance, setBalance] = useState(0);
  const [myCode, setMyCode] = useState('');

  const [mode, setMode] = useState<LookupMode>('code');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      const [bal, code] = await Promise.all([
        walletService.getBalance(userId, 'tricicoin'),
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

  const applyFound = useCallback((found: Recipient | null) => {
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
  }, [userId, t]);

  const resolveByCode = useCallback(async (code: string) => {
    const c = code.trim();
    if (!c) return;
    setSearching(true);
    setRecipient(null);
    try {
      applyFound(await walletService.findUserByGiftCode(c));
    } catch (err) {
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
    } finally {
      setSearching(false);
    }
  }, [applyFound]);

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;
    if (mode === 'code') { void resolveByCode(q); return; }
    setSearching(true);
    setRecipient(null);
    try {
      applyFound(await walletService.findUserByPhone(q));
    } catch (err) {
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
    } finally {
      setSearching(false);
    }
  };

  // Deep link / QR: tricigo-driver://gift/<code> opens this screen with
  // ?code=, which auto-resolves the recipient.
  useEffect(() => {
    if (codeParam) {
      setMode('code');
      setQuery(codeParam);
      void resolveByCode(codeParam);
    }
  }, [codeParam, resolveByCode]);

  const handleScanned = useCallback((code: string) => {
    setMode('code');
    setQuery(code);
    void resolveByCode(code);
  }, [resolveByCode]);

  const numericAmount = parseInt(amount, 10);
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0 && numericAmount <= balance;

  // One key per attempt (00518). It survives a retry — this send has no
  // timeout, so an error can surface long after the RPC already committed,
  // and replaying with the same key returns the original transfer instead of
  // debiting twice. It is discarded whenever the recipient, amount or note
  // changes, because replaying a key after an edit would resend the OLD gift
  // and silently drop the correction.
  const idempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [recipient?.id, amount, note]);

  const handleSend = async () => {
    if (!userId || !recipient || !amountValid) return;
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = newGiftIdempotencyKey();
    setSubmitting(true);
    try {
      // Driver "Regalar" gifts from the driver wallet (tricicoin) — the one
      // shown on this screen. Passing it explicitly avoids the role-based
      // fallback debiting the wrong wallet for multi-role/admin accounts.
      await walletService.sendGift(
        userId,
        recipient.id,
        numericAmount,
        note.trim() || undefined,
        'tricicoin',
        idempotencyKeyRef.current,
      );
      triggerHaptic('light');
      Toast.show({
        type: 'success',
        text1: t('gift.success_title', { defaultValue: '¡Regalo enviado!' }),
        text2: t('gift.success_msg', {
          defaultValue: 'Le enviaste {{amount}} a {{name}}',
          amount: formatCUP(numericAmount),
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
    try {
      // Lazy + guarded: a dev-client build that doesn't bundle the
      // expo-clipboard native module would otherwise throw at import time
      // and break the whole gift route. Fall back to the share sheet.
      const Clipboard = require('expo-clipboard');
      await Clipboard.setStringAsync(myCode);
      Toast.show({ type: 'success', text1: t('copied', { defaultValue: 'Copiado' }) });
      triggerHaptic('light');
    } catch {
      await handleShareCode();
    }
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
    <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }} className="pt-4">
        <ScreenHeader title={t('gift.title', { defaultValue: 'Enviar regalo' })} onBack={() => router.back()} />

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {/* Balance */}
          <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white flex-row items-center justify-between">
            <Text variant="bodySmall" color="primary" className="opacity-60">{t('gift.your_balance', { defaultValue: 'Tu saldo' })}</Text>
            <Text variant="h4" color="accent">{formatCUP(balance)}</Text>
          </Card>

          {/* Recipient lookup */}
          {!recipient ? (
            <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
              <Text variant="body" color="primary" className="font-semibold mb-3">
                {t('gift.find_recipient', { defaultValue: '¿A quién le regalas?' })}
              </Text>
              <View className="flex-row mb-3">
                <Pressable
                  onPress={() => { setMode('code'); setQuery(''); }}
                  style={{ backgroundColor: mode === 'code' ? colors.primary[500] : palette.bg.elev2 }}
                  className="flex-1 py-2 rounded-l-lg items-center"
                >
                  <Text variant="bodySmall" style={{ color: mode === 'code' ? '#fff' : palette.ink.secondary }}>
                    {t('gift.by_code', { defaultValue: 'Código' })}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => { setMode('phone'); setQuery(''); }}
                  style={{ backgroundColor: mode === 'phone' ? colors.primary[500] : palette.bg.elev2 }}
                  className="flex-1 py-2 rounded-r-lg items-center"
                >
                  <Text variant="bodySmall" style={{ color: mode === 'phone' ? '#fff' : palette.ink.secondary }}>
                    {t('gift.by_phone', { defaultValue: 'Teléfono' })}
                  </Text>
                </Pressable>
              </View>
              <Input
                variant="light"
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
              {Platform.OS !== 'web' ? (
                <Pressable onPress={() => setScannerOpen(true)} className="flex-row items-center justify-center mt-3" hitSlop={8}>
                  <Ionicons name="qr-code-outline" size={18} color={colors.primary[500]} />
                  <Text variant="bodySmall" color="accent" className="ml-2 font-medium">
                    {t('gift.scan_qr', { defaultValue: 'Escanear QR' })}
                  </Text>
                </Pressable>
              ) : null}
            </Card>
          ) : (
            <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white flex-row items-center justify-between">
              <View className="flex-row items-center flex-1">
                <Ionicons name="person-circle-outline" size={36} color={colors.primary[500]} />
                <View className="ml-3 flex-1">
                  <Text variant="caption" color="primary" className="opacity-50">{t('gift.sending_to', { defaultValue: 'Le regalas a' })}</Text>
                  <Text variant="body" color="primary" className="font-semibold" numberOfLines={1}>{recipient.full_name}</Text>
                </View>
              </View>
              <Pressable onPress={() => { setRecipient(null); setQuery(''); }}>
                <Text variant="bodySmall" color="accent">{t('gift.change', { defaultValue: 'Cambiar' })}</Text>
              </Pressable>
            </Card>
          )}

          {/* Amount + message */}
          {recipient ? (
            <Card theme="light" variant="filled" padding="md" className="mb-4 bg-white">
              <Text variant="body" color="primary" className="font-semibold mb-3">{t('gift.amount', { defaultValue: 'Monto del regalo' })}</Text>
              <Input
                variant="light"
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

              <Text variant="body" color="primary" className="font-semibold mb-2 mt-4">{t('gift.message_optional', { defaultValue: 'Mensaje (opcional)' })}</Text>
              <Input
                variant="light"
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
          <Card theme="light" variant="filled" padding="lg" className="mb-6 mt-2 bg-white items-center">
            <Text variant="bodySmall" color="primary" className="mb-2 opacity-60">
              {t('gift.my_code', { defaultValue: 'Tu código para recibir regalos' })}
            </Text>
            <Pressable onPress={handleCopyCode} className="flex-row items-center mb-3">
              <Text variant="h2" color="accent" className="tracking-widest">{myCode || '...'}</Text>
              {myCode ? (
                <Ionicons name="copy-outline" size={20} color={colors.primary[500]} style={{ marginLeft: 8 }} />
              ) : null}
            </Pressable>
            {QRCode && myCode ? (
              <View className="mb-3 p-3 bg-white rounded-2xl">
                <QRCode value={`tricigo-driver://gift/${myCode}`} size={160} />
              </View>
            ) : null}
            <Button
              title={t('gift.share_my_code', { defaultValue: 'Compartir mi código' })}
              variant="outline"
              size="md"
              onPress={handleShareCode}
              disabled={!myCode}
            />
          </Card>
        </ScrollView>

        <GiftQrScanner visible={scannerOpen} onClose={() => setScannerOpen(false)} onScanned={handleScanned} />
      </View>
    </Screen>
  );
}
