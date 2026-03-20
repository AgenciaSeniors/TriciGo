import React, { useState, useEffect } from 'react';
import { View, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { isValidCubanPhone, normalizeCubanPhone, isValidOTP } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';

type Step = 'phone' | 'otp';

export default function VerifyPhoneScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendTimer, setResendTimer] = useState(0);
  const [normalizedPhone, setNormalizedPhone] = useState('');

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

  const handleSendCode = async () => {
    setError('');
    if (!isValidCubanPhone(phone)) {
      setError(t('auth.invalid_phone'));
      return;
    }

    const normalized = normalizeCubanPhone(phone);
    setNormalizedPhone(normalized);
    setLoading(true);
    try {
      // Link phone to the current OAuth account (sends OTP)
      await authService.linkPhone(normalized);
      setStep('otp');
      setResendTimer(60);
    } catch {
      setError(t('errors.generic'));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    setError('');
    if (!isValidOTP(code)) {
      setError(t('auth.invalid_otp'));
      return;
    }

    setLoading(true);
    try {
      await authService.verifyPhoneLink(normalizedPhone, code);
      // Update user profile with the phone
      if (user) {
        const updated = await authService.updateProfile(user.id, { phone: normalizedPhone });
        setUser(updated);
      }
      // Navigation handled by auth guard in _layout.tsx
    } catch {
      setError(t('errors.generic'));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    try {
      await authService.linkPhone(normalizedPhone);
      setResendTimer(60);
    } catch {
      setError(t('errors.generic'));
    }
  };

  return (
    <Screen bg="white" padded={false}>
      <LinearGradient
        colors={['#FF4D00', '#FF6B2C']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{ height: 4 }}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <View className="flex-1 justify-center px-6">
          {/* Icon */}
          <View
            className="w-20 h-20 rounded-full items-center justify-center mb-6"
            style={{ backgroundColor: 'rgba(255, 77, 0, 0.08)' }}
          >
            <Ionicons
              name={step === 'phone' ? 'call-outline' : 'shield-checkmark-outline'}
              size={40}
              color={colors.brand.orange}
            />
          </View>

          {step === 'phone' ? (
            <>
              <Text variant="h3" className="mb-2">
                {t('auth.verify_phone_title', { defaultValue: 'Verifica tu teléfono' })}
              </Text>
              <Text variant="body" color="secondary" className="mb-8">
                {t('auth.verify_phone_subtitle', {
                  defaultValue: 'Necesitamos tu número para contactarte durante el viaje y para emergencias',
                })}
              </Text>

              <View className="flex-row items-center gap-2 mb-1">
                <View className="bg-neutral-100 rounded-xl px-3 py-3.5 flex-row items-center">
                  <Text variant="body" className="font-semibold">🇨🇺 +53</Text>
                </View>
                <View className="flex-1">
                  <Input
                    placeholder="5XXXXXXX"
                    keyboardType="phone-pad"
                    value={phone}
                    onChangeText={setPhone}
                    autoFocus
                  />
                </View>
              </View>

              {error ? (
                <Text variant="bodySmall" color="error" className="mb-2">{error}</Text>
              ) : null}

              <Button
                title={t('auth.send_code')}
                onPress={handleSendCode}
                loading={loading}
                disabled={phone.length < 7 || loading}
                fullWidth
                size="lg"
                className="mt-2"
              />
            </>
          ) : (
            <>
              <Text variant="h3" className="mb-2">
                {t('auth.otp_title')}
              </Text>
              <Text variant="body" color="secondary" className="mb-2">
                {t('auth.otp_subtitle', { phone: normalizedPhone })}
              </Text>

              <View className="bg-neutral-50 rounded-xl px-4 py-2.5 flex-row items-center mb-8 self-start">
                <Ionicons name="call-outline" size={16} color={colors.brand.orange} />
                <Text variant="body" className="ml-2 font-semibold">{normalizedPhone}</Text>
              </View>

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
                <Text variant="bodySmall" color="error" className="mb-2">{error}</Text>
              ) : null}

              <Button
                title={t('auth.verify')}
                onPress={handleVerifyOTP}
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

              {/* Back to phone input */}
              <Button
                title={t('auth.change_phone', { defaultValue: 'Cambiar número' })}
                variant="ghost"
                onPress={() => { setStep('phone'); setCode(''); setError(''); }}
                className="mt-2"
                fullWidth
              />
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
