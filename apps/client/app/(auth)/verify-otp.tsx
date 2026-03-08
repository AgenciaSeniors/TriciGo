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
      // TODO: Implement authService.verifyOTP(phone, code)
      router.replace('/(tabs)');
    } catch {
      // Handle error
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen scroll bg="white">
      <View className="flex-1 justify-center px-2">
        <Text variant="h3" className="mb-2">
          {t('auth.otp_title')}
        </Text>
        <Text variant="body" color="secondary" className="mb-8">
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

        <Button
          title={t('auth.resend_code')}
          variant="ghost"
          onPress={() => {}}
          className="mt-4"
          fullWidth
        />
      </View>
    </Screen>
  );
}
