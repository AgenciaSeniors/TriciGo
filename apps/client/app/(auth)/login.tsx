import React, { useState } from 'react';
import { View, Image } from 'react-native';
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

    const normalized = normalizeCubanPhone(phone);
    setLoading(true);
    try {
      await authService.sendOTP(normalized);
      router.push({ pathname: '/(auth)/verify-otp', params: { phone: normalized } });
    } catch {
      setError(t('errors.generic'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen scroll bg="white">
      <View className="flex-1 justify-center px-2">
        <Image
          source={require('../../assets/logo-wordmark.png')}
          style={{ width: 220, height: 52 }}
          resizeMode="contain"
          className="mb-2"
        />
        <Text variant="body" color="secondary" className="mb-8">
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
      </View>
    </Screen>
  );
}
