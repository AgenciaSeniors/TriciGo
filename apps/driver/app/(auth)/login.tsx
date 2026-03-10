import React, { useState } from 'react';
import { View, Image, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { isValidCubanPhone, normalizeCubanPhone } from '@tricigo/utils';

export default function LoginScreen() {
  const { t } = useTranslation('common');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSendCode = async () => {
    setError('');
    if (!isValidCubanPhone(phone)) {
      setError(t('auth.invalid_phone'));
      return;
    }

    setLoading(true);
    try {
      const normalized = normalizeCubanPhone(phone);
      await authService.sendOTP(normalized);
      router.push({ pathname: '/(auth)/verify-otp', params: { phone: normalized } });
    } catch {
      setError(t('errors.generic'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content">
      <View className="flex-1 justify-center px-2">
        <Image
          source={require('../../assets/logo-wordmark-white.png')}
          style={{ width: 220, height: 52 }}
          resizeMode="contain"
          className="mb-1"
        />
        <Text variant="body" color="inverse" className="mb-1 opacity-60">
          Conductor
        </Text>
        <Text variant="bodySmall" color="inverse" className="mb-8 opacity-40">
          {t('auth.phone_label')}
        </Text>

        <Input
          label={t('auth.phone_placeholder')}
          placeholder="+53 5XXXXXXX"
          keyboardType="phone-pad"
          value={phone}
          onChangeText={setPhone}
          autoFocus
        />

        {error ? (
          <Text variant="bodySmall" color="error" className="mb-2">
            {error}
          </Text>
        ) : null}

        <Button
          title={t('auth.send_code')}
          onPress={handleSendCode}
          loading={loading}
          disabled={phone.length < 8 || loading}
          fullWidth
          size="lg"
        />

        {/* Divider */}
        <View className="flex-row items-center my-6">
          <View className="flex-1 h-px bg-neutral-700" />
          <Text variant="caption" color="inverse" className="mx-4 opacity-50">
            {t('auth.or_continue_with', { defaultValue: 'o continúa con' })}
          </Text>
          <View className="flex-1 h-px bg-neutral-700" />
        </View>

        {/* Social login */}
        <View className="flex-row gap-3">
          <Pressable
            className="flex-1 flex-row items-center justify-center py-3.5 rounded-xl border border-neutral-600"
            onPress={() => authService.signInWithGoogle()}
          >
            <Text variant="body" color="inverse">Google</Text>
          </Pressable>
          <Pressable
            className="flex-1 flex-row items-center justify-center py-3.5 rounded-xl border border-neutral-600"
            onPress={() => authService.signInWithApple()}
          >
            <Text variant="body" color="inverse">Apple</Text>
          </Pressable>
        </View>
      </View>
    </Screen>
  );
}
