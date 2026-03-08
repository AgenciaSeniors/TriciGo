import React, { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';

export default function LoginScreen() {
  const { t } = useTranslation('common');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSendCode = async () => {
    setLoading(true);
    try {
      router.push({ pathname: '/(auth)/verify-otp', params: { phone } });
    } catch {
      // Handle error
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content">
      <View className="flex-1 justify-center px-2">
        <Text variant="h2" color="inverse" className="mb-1">
          Trici
          <Text variant="h2" color="accent">Go</Text>
        </Text>
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

        <Button
          title={t('auth.send_code')}
          onPress={handleSendCode}
          loading={loading}
          fullWidth
          size="lg"
        />
      </View>
    </Screen>
  );
}
