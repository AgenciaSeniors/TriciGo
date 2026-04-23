import React, { useState, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { authService, driverService } from '@tricigo/api';
import { isValidOTP } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';

export default function VerifyOTPScreen() {
  const { t } = useTranslation('common');
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const setUser = useAuthStore((s) => s.setUser);
  const setProfile = useDriverStore((s) => s.setProfile);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendTimer, setResendTimer] = useState(60);
  // Prevent the auto-submit effect from firing multiple times if code stays
  // at 6 digits (e.g. user retyped the same value).
  const autoVerifiedRef = useRef(false);

  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(() => {
      setResendTimer((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendTimer]);

  const handleVerify = async () => {
    setError('');
    if (!isValidOTP(code)) {
      setError(t('auth.invalid_otp'));
      Toast.show({ type: 'error', text1: t('auth.invalid_otp'), visibilityTime: 2500 });
      return;
    }

    setLoading(true);
    try {
      await authService.verifyOTP(phone!, code);
      const user = await authService.getCurrentUser();
      setUser(user);
      if (user) {
        try {
          const dp = await driverService.getProfile(user.id);
          setProfile(dp);
        } catch {
          // No driver profile yet - will redirect to onboarding
        }
      }
    } catch {
      setError(t('errors.generic'));
      Toast.show({ type: 'error', text1: t('auth.invalid_otp', { defaultValue: 'Código inválido' }), visibilityTime: 2500 });
      // Let the user retry with a new code — reset the auto-submit guard.
      autoVerifiedRef.current = false;
    } finally {
      setLoading(false);
    }
  };

  // UX: auto-submit when 6 digits entered — saves a tap on the most
  // common path. Guarded by autoVerifiedRef to avoid resubmit loops and
  // `loading` so we don't fire while a previous attempt is in flight.
  useEffect(() => {
    if (code.length === 6 && !autoVerifiedRef.current && !loading) {
      autoVerifiedRef.current = true;
      handleVerify();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // UX: clear error as soon as user retypes so red text doesn't linger.
  const handleCodeChange = (v: string) => {
    // strip non-digits
    const digits = v.replace(/[^0-9]/g, '').slice(0, 6);
    setCode(digits);
    if (error) setError('');
    if (digits.length < 6) autoVerifiedRef.current = false;
  };

  const handleResend = async () => {
    try {
      await authService.sendOTP(phone!);
      setResendTimer(60);
      Toast.show({
        type: 'success',
        text1: t('auth.otp_resent', { defaultValue: 'Código reenviado' }),
        visibilityTime: 2000,
      });
    } catch {
      setError(t('errors.generic'));
      Toast.show({ type: 'error', text1: t('errors.generic'), visibilityTime: 2500 });
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
          onChangeText={handleCodeChange}
          autoFocus
          variant="dark"
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
          disabled={code.length < 6 || loading}
          fullWidth
          size="lg"
        />

        <View className="mt-4 items-center">
          {resendTimer > 0 ? (
            <Text variant="bodySmall" color="inverse" className="opacity-40">
              {t('auth.resend_in', { seconds: resendTimer })}
            </Text>
          ) : (
            <Button
              title={t('auth.resend_code')}
              onPress={handleResend}
              variant="ghost"
              size="sm"
              forceDark
            />
          )}
        </View>
      </View>
    </Screen>
  );
}
