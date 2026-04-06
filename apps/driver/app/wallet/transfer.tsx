import React, { useState, useCallback } from 'react';
import { View, Pressable, Alert, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';

interface FoundUser {
  id: string;
  full_name: string;
  phone: string;
}

type Step = 'search' | 'amount' | 'confirm';

export default function TransferScreen() {
  const { t } = useTranslation('driver');
  const insets = useSafeAreaInsets();
  const userId = useAuthStore((s) => s.user?.id);

  const [step, setStep] = useState<Step>('search');
  const [phone, setPhone] = useState('');
  const [searching, setSearching] = useState(false);
  const [recipient, setRecipient] = useState<FoundUser | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!phone.trim()) return;
    setSearching(true);
    try {
      const user = await walletService.findUserByPhone(phone.trim());
      if (!user) {
        Alert.alert(
          t('wallet.user_not_found_title', { defaultValue: 'Usuario no encontrado' }),
          t('wallet.user_not_found', { defaultValue: 'No se encontro un usuario con ese numero de telefono.' }),
        );
        return;
      }
      if (user.id === userId) {
        Alert.alert(
          t('wallet.self_transfer_title', { defaultValue: 'Error' }),
          t('wallet.self_transfer', { defaultValue: 'No puedes transferirte a ti mismo.' }),
        );
        return;
      }
      setRecipient(user);
      setStep('amount');
    } catch {
      Alert.alert('Error', t('wallet.search_error', { defaultValue: 'Error al buscar usuario.' }));
    } finally {
      setSearching(false);
    }
  }, [phone, userId, t]);

  const handleConfirm = useCallback(async () => {
    if (!userId || !recipient || !amount) return;
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      Alert.alert('Error', t('wallet.invalid_amount', { defaultValue: 'Monto invalido.' }));
      return;
    }

    setSending(true);
    try {
      await walletService.transferP2P(userId, recipient.id, numAmount, note || undefined);
      Alert.alert(
        t('wallet.transfer_success_title', { defaultValue: 'Transferencia exitosa' }),
        t('wallet.transfer_success', {
          defaultValue: `Se transfirieron ${formatCUP(numAmount)} a ${recipient.full_name}.`,
          amount: formatCUP(numAmount),
          name: recipient.full_name,
        }),
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      Alert.alert('Error', message);
    } finally {
      setSending(false);
    }
  }, [userId, recipient, amount, note, t]);

  return (
    <Screen bg="dark" statusBarStyle="light-content">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16, paddingHorizontal: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View className="flex-row items-center mb-6">
            <Pressable
              onPress={() => {
                if (step === 'amount') { setStep('search'); return; }
                if (step === 'confirm') { setStep('amount'); return; }
                router.back();
              }}
              className="w-11 h-11 rounded-xl items-center justify-center mr-3"
              style={{ backgroundColor: '#252540' }}
              accessibilityRole="button"
              accessibilityLabel={t('common.back', { defaultValue: 'Volver' })}
            >
              <Ionicons name="arrow-back" size={20} color="#fff" />
            </Pressable>
            <Text variant="h2" color="inverse">
              {t('wallet.transfer', { defaultValue: 'Transferir' })}
            </Text>
          </View>

          {/* Step indicator */}
          <View className="flex-row mb-6 gap-2">
            {(['search', 'amount', 'confirm'] as Step[]).map((s, i) => (
              <View
                key={s}
                className="flex-1 h-1 rounded-full"
                style={{
                  backgroundColor: i <= ['search', 'amount', 'confirm'].indexOf(step)
                    ? colors.brand.orange
                    : '#252540',
                }}
              />
            ))}
          </View>

          {/* Step 1: Search */}
          {step === 'search' && (
            <View>
              <Text variant="h3" color="inverse" className="mb-2">
                {t('wallet.find_recipient', { defaultValue: 'Buscar destinatario' })}
              </Text>
              <Text variant="bodySmall" color="secondary" className="mb-6">
                {t('wallet.enter_phone', { defaultValue: 'Ingresa el numero de telefono del destinatario.' })}
              </Text>
              <Input
                label={t('wallet.phone_label', { defaultValue: 'Numero de telefono' })}
                placeholder="+53 5XXXXXXX"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoFocus
                variant="dark"
              />
              <Button
                title={searching ? t('wallet.searching', { defaultValue: 'Buscando...' }) : t('wallet.search', { defaultValue: 'Buscar' })}
                onPress={handleSearch}
                disabled={!phone.trim() || searching}
                loading={searching}
                size="lg"
                fullWidth
                className="mt-4"
              />
            </View>
          )}

          {/* Step 2: Amount */}
          {step === 'amount' && recipient && (
            <View>
              {/* Recipient card */}
              <Card forceDark variant="surface" padding="md" className="mb-6">
                <View className="flex-row items-center">
                  <View
                    className="w-12 h-12 rounded-full items-center justify-center mr-3"
                    style={{ backgroundColor: '#252540' }}
                  >
                    <Ionicons name="person" size={22} color={colors.brand.orange} />
                  </View>
                  <View>
                    <Text variant="body" color="inverse" className="font-semibold">
                      {recipient.full_name}
                    </Text>
                    <Text variant="caption" color="secondary">
                      {recipient.phone}
                    </Text>
                  </View>
                </View>
              </Card>

              <Input
                label={t('wallet.amount_label', { defaultValue: 'Monto (CUP)' })}
                placeholder="0"
                value={amount}
                onChangeText={setAmount}
                keyboardType="numeric"
                autoFocus
                variant="dark"
              />

              <Input
                label={t('wallet.note_label', { defaultValue: 'Nota (opcional)' })}
                placeholder={t('wallet.note_placeholder', { defaultValue: 'Ej: Pago de viaje compartido' })}
                value={note}
                onChangeText={setNote}
                className="mt-3"
                variant="dark"
              />

              <Button
                title={t('wallet.continue', { defaultValue: 'Continuar' })}
                onPress={() => {
                  const numAmount = Number(amount);
                  if (isNaN(numAmount) || numAmount <= 0) {
                    Alert.alert('Error', t('wallet.invalid_amount', { defaultValue: 'Monto invalido.' }));
                    return;
                  }
                  setStep('confirm');
                }}
                disabled={!amount || Number(amount) <= 0}
                size="lg"
                fullWidth
                className="mt-6"
              />
            </View>
          )}

          {/* Step 3: Confirm */}
          {step === 'confirm' && recipient && (
            <View>
              <Text variant="h3" color="inverse" className="mb-4 text-center">
                {t('wallet.confirm_transfer', { defaultValue: 'Confirmar transferencia' })}
              </Text>

              <Card forceDark variant="surface" padding="lg" className="mb-6">
                {/* Amount */}
                <View className="items-center mb-4">
                  <Text variant="stat" color="accent">
                    {formatCUP(Number(amount))}
                  </Text>
                </View>

                {/* Recipient */}
                <View className="flex-row items-center justify-between py-3 border-t border-white/6">
                  <Text variant="bodySmall" color="secondary">
                    {t('wallet.to', { defaultValue: 'Para' })}
                  </Text>
                  <Text variant="body" color="inverse" className="font-semibold">
                    {recipient.full_name}
                  </Text>
                </View>

                <View className="flex-row items-center justify-between py-3 border-t border-white/6">
                  <Text variant="bodySmall" color="secondary">
                    {t('wallet.phone_label', { defaultValue: 'Telefono' })}
                  </Text>
                  <Text variant="body" color="inverse">
                    {recipient.phone}
                  </Text>
                </View>

                {note ? (
                  <View className="flex-row items-center justify-between py-3 border-t border-white/6">
                    <Text variant="bodySmall" color="secondary">
                      {t('wallet.note_label', { defaultValue: 'Nota' })}
                    </Text>
                    <Text variant="body" color="inverse" className="flex-1 text-right ml-4">
                      {note}
                    </Text>
                  </View>
                ) : null}
              </Card>

              <Button
                title={sending ? t('wallet.sending', { defaultValue: 'Enviando...' }) : t('wallet.send', { defaultValue: 'Enviar' })}
                onPress={handleConfirm}
                disabled={sending}
                loading={sending}
                size="lg"
                fullWidth
              />

              <Pressable
                onPress={() => setStep('amount')}
                className="items-center mt-4 min-h-[48px] justify-center"
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel', { defaultValue: 'Cancelar' })}
              >
                <Text variant="body" color="secondary">
                  {t('common.cancel', { defaultValue: 'Cancelar' })}
                </Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
