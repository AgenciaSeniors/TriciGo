import React, { useState, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { authService, deviceService, driverService, isRateLimitError } from '@tricigo/api';
import { isValidOTP } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { getDeviceInfo } from '@/lib/device';

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
  // R-3: once verifyOTP succeeds the single-use code is consumed and the
  // session is set. If the *profile* fetch then fails (transient network),
  // we must NOT re-run verifyOTP (it would fail "invalid code" and strand
  // the driver) — this ref lets a retry resume at phase 2 only.
  const sessionEstablishedRef = useRef(false);

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
      // Phase 1 — verify the OTP (burns the single-use code + sets the
      // session). Skipped on retry: re-running a consumed code fails with
      // "invalid code" and would strand the driver (R-3).
      if (!sessionEstablishedRef.current) {
        await authService.verifyOTP(phone!, code);
        sessionEstablishedRef.current = true;
      }
      // Phase 2 — load the profile. The session is already established, so a
      // transient network blip here must NOT be reported as an invalid code.
      // Retry a few times before giving up.
      let user = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          user = await authService.getCurrentUser();
          if (user) break;
        } catch (e) {
          if (attempt === 3) throw e;
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 600));
      }
      if (!user) throw new Error('profile_unavailable');
      setUser(user);
      // Record this device for new-device login detection. Best-effort:
      // never block login on it.
      getDeviceInfo()
        .then((info) => deviceService.registerLoginDevice(info))
        .catch(() => {});
      try {
        const dp = await driverService.getProfile(user.id);
        setProfile(dp);
      } catch {
        // No driver profile yet - will redirect to onboarding
      }
    } catch (err) {
      if (sessionEstablishedRef.current) {
        // The code was accepted; only the profile fetch failed (network).
        // Retrying resumes at phase 2 (no OTP re-burn); the stored session
        // also logs the driver in on a cold restart.
        setError(t('auth.profile_fetch_retry', { defaultValue: 'Conexión inestable. Toca "Verificar" otra vez.' }));
        Toast.show({ type: 'error', text1: t('auth.profile_fetch_retry', { defaultValue: 'Conexión inestable. Toca "Verificar" otra vez.' }), visibilityTime: 2500 });
      } else {
        // Distinguish "expired" from "wrong digits" via the EF's stable reason
        // code (set by authService.verifyOTP) so the driver knows whether to
        // retype or request a new code.
        const reason = (err as { code?: string } | null)?.code;
        const msg =
          reason === 'expired'
            ? t('auth.otp_expired', { defaultValue: 'El código expiró. Pide uno nuevo.' })
            : reason === 'invalid'
              ? t('auth.otp_incorrect', { defaultValue: 'Código incorrecto. Revisa los dígitos.' })
              : reason === 'too_many_attempts'
                ? t('auth.otp_too_many', { defaultValue: 'Demasiados intentos. Pide un código nuevo.' })
                : t('errors.generic');
        setError(msg);
        Toast.show({ type: 'error', text1: msg, visibilityTime: 2500 });
      }
      // Let the user retry — reset the auto-submit guard.
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
        text1: t('auth.resend_success_title', { defaultValue: 'Código reenviado' }),
        text2: t('auth.resend_success_body', { defaultValue: 'Revisa los mensajes del teléfono.' }),
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
          text2: t('auth.otp_rate_limited_body', { defaultValue: 'Espera unos minutos antes de pedir otro código.' }),
          visibilityTime: 3000,
        });
      } else {
        setError(t('errors.generic'));
        Toast.show({ type: 'error', text1: t('errors.generic'), visibilityTime: 2500 });
      }
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

        <Button
          title={resendTimer > 0 ? `${t('auth.resend_code')} (${resendTimer}s)` : t('auth.resend_code')}
          variant="ghost"
          onPress={handleResend}
          disabled={resendTimer > 0 || loading}
          forceDark
          className="mt-4"
          fullWidth
        />
      </View>
    </Screen>
  );
}
