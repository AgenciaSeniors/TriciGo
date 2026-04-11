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
import { formatCUP } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import Toast from 'react-native-toast-message';

const PRESET_AMOUNTS = [500, 1000, 2000, 5000];

export default function RechargeScreen() {
  const { t } = useTranslation('driver');
  const insets = useSafeAreaInsets();

  const [amount, setAmount] = useState('');
  const [customAmount, setCustomAmount] = useState('');

  const selectedAmount = amount ? Number(amount) : Number(customAmount);

  const handleRecharge = () => {
    Toast.show({
      type: 'info',
      text1: t('wallet.coming_soon_recharge', { defaultValue: 'Proximamente: recarga con tarjeta' }),
      visibilityTime: 3000,
    });
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

        <Button
          title={t('wallet.recharge_button', { defaultValue: 'Recargar' })}
          onPress={handleRecharge}
          disabled={selectedAmount <= 0}
          size="lg"
          fullWidth
          className="mt-6"
        />
      </ScrollView>
    </Screen>
  );
}
