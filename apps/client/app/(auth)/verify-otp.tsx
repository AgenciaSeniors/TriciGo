import React, { useState, useEffect, useRef } from 'react';
import { View, Pressable } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { authService, deviceService, isRateLimitError } from '@tricigo/api';
import { isValidOTP, triggerHaptic } from '@tricigo/utils';
import { colors, darkColors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore } from '@/stores/theme.store';
import { getDeviceInfo } from '@/lib/device';

export default function VerifyOTPScreen() {
  const { t } = useTranslation('common');
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const setUser = useAuthStore((s) => s.setUser);
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendTimer, setResendTimer] = useState(60);
  // UX: auto-submit guard so we don't fire handleVerify twice if the user
  // pastes then also taps Verify. Same pattern shipped in driver R5.
  const autoVerifiedRef = useRef(false);

  // Use a stable effect that only re-runs when timer starts (not on every tick)
  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(() => {
      setResendTimer((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resendTimer > 0]);

  const handleVerify = async () => {
    setError('');

    if (!isValidOTP(code)) {
      setError(t('auth.invalid_otp'));
      return;
    }

    setLoading(true);
    try {
      await authService.verifyOTP(phone, code);
      const user = await authService.getCurrentUser();
      setUser(user);
      // Record this device for new-device login detection. Best-effort:
      // never block login on it.
      getDeviceInfo()
        .then((info) => deviceService.registerLoginDevice(info))
        .catch(() => {});
      // Navigation is automatic via auth guard
    } catch {
      setError(t('errors.generic'));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    try {
      await authService.sendOTP(phone);
      setResendTimer(60);
      // UX: silent success used to leave the user wondering whether a new
      // SMS was actually triggered — they'd stare at their inbox. A toast
      // confirms the send and matches driver R5.
      triggerHaptic('light');
      Toast.show({
        type: 'success',
        text1: t('auth.resend_success_title', { defaultValue: 'Código reenviado' }),
        text2: t('auth.resend_success_body', { defaultValue: 'Revisá los mensajes del teléfono.' }),
        visibilityTime: 2500,
      });
    } catch (err) {
      // Rate limited (429): keep the button disabled for the server-provided
      // cooldown and tell the user why, instead of a vague generic error.
      if (isRateLimitError(err)) {
        setResendTimer(err.retryAfterSec);
        Toast.show({
          type: 'error',
          text1: t('auth.otp_rate_limited_title', { defaultValue: 'Demasiados códigos' }),
          text2: t('auth.otp_rate_limited_body', { defaultValue: 'Esperá unos minutos antes de pedir otro código.' }),
          visibilityTime: 3000,
        });
      } else {
        setError(t('errors.generic'));
      }
    }
  };

  // Auto-submit when user reaches the 6-digit code (pastes or types the last
  // digit). Mirrors driver R5's auto-verify — eliminates the redundant tap.
  useEffect(() => {
    if (code.length === 6 && !loading && !autoVerifiedRef.current) {
      autoVerifiedRef.current = true;
      handleVerify();
    }
    // Reset guard if user shortens the code (backspace after fail)
    if (code.length < 6) autoVerifiedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Guard: phone param is required (rendered after hooks to satisfy rules-of-hooks)
  if (!phone) {
    return (
      <Screen bg="white" padded>
        <View className="flex-1 justify-center items-center">
          <Text variant="body" color="error">{t('errors.generic')}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="white" padded={false}>
      {/* Top accent bar */}
      <LinearGradient
        colors={['#FF4D00', '#FF6B2C']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{ height: 4 }}
      />

      <View className="flex-1 justify-center px-6">
        {/* Back button */}
        <Pressable
          onPress={() => router.back()}
          className="flex-row items-center mb-6"
          hitSlop={16}
        >
          <Ionicons name="arrow-back" size={20} color={isDark ? darkColors.text.secondary : colors.neutral[400]} />
          <Text variant="bodySmall" color="secondary" className="ml-1">
            {t('auth.back_to_login', { defaultValue: 'Volver' })}
          </Text>
        </Pressable>

        {/* Shield icon */}
        <View
          className="w-20 h-20 rounded-full items-center justify-center mb-6"
          style={{
            backgroundColor: isDark ? 'rgba(255, 77, 0, 0.15)' : 'rgba(255, 77, 0, 0.08)',
          }}
        >
          <Ionicons name="shield-checkmark-outline" size={40} color={colors.brand.orange} />
        </View>

        <Text variant="h3" className="mb-2">
          {t('auth.otp_title')}
        </Text>
        <Text variant="body" color="secondary" className="mb-2">
          {t('auth.otp_subtitle', { phone })}
        </Text>

        {/* Phone number display */}
        <View className="bg-neutral-50 dark:bg-neutral-800 rounded-xl px-4 py-2.5 flex-row items-center mb-8 self-start">
          <Ionicons name="call-outline" size={16} color={colors.brand.orange} />
          <Text variant="body" className="ml-2 font-semibold">{phone}</Text>
        </View>

        <Input
          label={t('auth.otp_placeholder')}
          placeholder="000000"
          keyboardType="number-pad"
          maxLength={6}
          value={code}
          onChangeText={(v) => {
            // UX: clear any stale error the moment the user starts
            // retyping — seeing "Código inválido" while typing the
            // corrected value felt punitive. Pattern from driver R5.
            if (error) setError('');
            setCode(v);
          }}
          leftIcon={<Ionicons name="keypad-outline" size={20} color={isDark ? darkColors.text.secondary : colors.neutral[400]} />}
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
          disabled={resendTimer > 0 || loading}
          className="mt-4"
          fullWidth
        />
      </View>
    </Screen>
  );
}
