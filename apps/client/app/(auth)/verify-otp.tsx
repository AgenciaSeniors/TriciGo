import React, { useState, useEffect } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { isValidOTP } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';

export default function VerifyOTPScreen() {
  const { t } = useTranslation('common');
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const setUser = useAuthStore((s) => s.setUser);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendTimer, setResendTimer] = useState(60);

  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(() => {
      setResendTimer((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [resendTimer]);

  const handleVerify = async () => {
    setError('');

    if (!isValidOTP(code)) {
      setError(t('auth.invalid_otp'));
      return;
    }

    setLoading(true);
    try {
      await authService.verifyOTP(phone!, code);
      const user = await authService.getCurrentUser();
      setUser(user);
      // Navigation is automatic via auth guard
    } catch {
      setError(t('errors.generic'));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    try {
      await authService.sendOTP(phone!);
      setResendTimer(60);
    } catch {
      setError(t('errors.generic'));
    }
  };

  return (
    <Screen bg="white" padded={false}>
      <View className="flex-1 justify-center px-6">
        {/* Decorative icon */}
        <View className="w-20 h-20 rounded-full bg-primary-50 items-center justify-center mb-6">
          <Ionicons name="shield-checkmark-outline" size={40} color={colors.brand.orange} />
        </View>

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
          leftIcon={<Ionicons name="keypad-outline" size={20} color={colors.neutral[400]} />}
          autoFocus
        />

        {error ? (
          <Text variant="bodySmall" color="error" className="mb-2">
            {error}
          </Text>
        ) : null}

        <Button
          title={t('auth.verify')}
          onPress={handleVerify}
          loading={loading}
          disabled={code.length !== 6 || loading}
          fullWidth
          size="lg"
        />

        <Button
          title={resendTimer > 0 ? `${t('auth.resend_code')} (${resendTimer}s)` : t('auth.resend_code')}
          variant="ghost"
          onPress={handleResend}
          disabled={resendTimer > 0}
          className="mt-4"
          fullWidth
        />
      </View>
    </Screen>
  );
}
