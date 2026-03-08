import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';

export default function VerifyOTPScreen() {
  const { t } = useTranslation('common');
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  const handleVerify = async () => {
    setLoading(true);
    try {
      router.replace('/(tabs)');
    } catch {
      // Handle error
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content">
      <View className="flex-1 justify-center px-2">
        <Text variant="h3" color="inverse" className="mb-2">
          {t('auth.otp_title')}
        </Text>
        <Text variant="body" color="inverse" className="mb-8 opacity-60">
          {t('auth.otp_subtitle', { phone })}
        </Text>

        <Input
          label={t('auth.otp_placeholder')}
          placeholder="000000"
          keyboardType="number-pad"
          maxLength={6}
          value={code}
          onChangeText={setCode}
          autoFocus
        />

        <Button
          title={t('auth.verify')}
          onPress={handleVerify}
          loading={loading}
          fullWidth
          size="lg"
        />
      </View>
    </Screen>
  );
}
