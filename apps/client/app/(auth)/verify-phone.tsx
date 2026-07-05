import React, { useState, useEffect } from 'react';
import { View, KeyboardAvoidingView, Platform, Alert, Pressable, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { isValidCubanPhone, normalizeCubanPhone, isValidOTP, triggerHaptic } from '@tricigo/utils';
import { DEMO_MODE, DEMO_DIAL_CODES, isValidDemoPhone, normalizeDemoPhone } from '@/config/demo';
import { colors, darkColors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore } from '@/stores/theme.store';
import { useTokens } from '@/hooks/useTokens';
import { SwitchAccountFooter } from '@/components/auth/SwitchAccountFooter';

type Step = 'phone' | 'otp';

export default function VerifyPhoneScreen() {
  const { t } = useTranslation('common');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const tokens = useTokens();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [dialCode, setDialCode] = useState<string>(DEMO_MODE ? DEMO_DIAL_CODES[0]!.code : '+53');
  const [dialPickerOpen, setDialPickerOpen] = useState(false);
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
    const isValid = DEMO_MODE ? isValidDemoPhone(phone) : isValidCubanPhone(phone);
    if (!isValid) {
      setError(t('auth.invalid_phone'));
      return;
    }

    const normalized = DEMO_MODE
      ? normalizeDemoPhone(phone, dialCode)
      : normalizeCubanPhone(phone);
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
    } catch (err) {
      // Surface the EF's stable error code (set by verifyPhoneLink) instead of
      // a generic message: PHONE_TAKEN / INVALID_CODE reuse existing translated
      // copy so the user knows whether to pick another number or retype.
      const code = (err as { code?: string } | null)?.code;
      setError(
        code === 'PHONE_TAKEN'
          ? t('auth.phone_taken_existing_account')
          : code === 'INVALID_CODE'
            ? t('auth.invalid_otp')
            : t('errors.generic'),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    try {
      await authService.linkPhone(normalizedPhone);
      setResendTimer(60);
      // UX: mirrors verify-otp + driver R5 — silent resend makes the
      // user wonder if the send actually fired.
      triggerHaptic('light');
      Toast.show({
        type: 'success',
        text1: t('auth.resend_success_title', { defaultValue: 'Código reenviado' }),
        text2: t('auth.resend_success_body', { defaultValue: 'Revisá los mensajes del teléfono.' }),
        visibilityTime: 2500,
      });
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
            style={{ backgroundColor: isDark ? 'rgba(255, 77, 0, 0.15)' : 'rgba(255, 77, 0, 0.08)' }}
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
                {DEMO_MODE ? (
                  <Pressable
                    onPress={() => setDialPickerOpen(true)}
                    className="bg-neutral-100 dark:bg-neutral-800 rounded-xl px-3 py-3.5 flex-row items-center gap-1"
                    accessibilityRole="button"
                  >
                    <Text variant="body" className="font-semibold">
                      {DEMO_DIAL_CODES.find((d) => d.code === dialCode)?.emoji ?? '🏳️'} {dialCode}
                    </Text>
                  </Pressable>
                ) : (
                  <View className="bg-neutral-100 dark:bg-neutral-800 rounded-xl px-3 py-3.5 flex-row items-center">
                    <Text variant="body" className="font-semibold">🇨🇺 +53</Text>
                  </View>
                )}
                <View className="flex-1">
                  <Input
                    placeholder={DEMO_MODE ? '999999999' : '5XXXXXXX o 6XXXXXXX'}
                    keyboardType="phone-pad"
                    value={phone}
                    onChangeText={setPhone}
                    autoFocus
                  />
                </View>
              </View>

              {/* Dial-code picker (demo mode only) */}
              {DEMO_MODE && dialPickerOpen && (
                <Modal transparent animationType="fade" onRequestClose={() => setDialPickerOpen(false)}>
                  <Pressable
                    style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', paddingHorizontal: 24 }}
                    onPress={() => setDialPickerOpen(false)}
                  >
                    <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 12 }}>
                      {DEMO_DIAL_CODES.map((d) => (
                        <Pressable
                          key={d.code}
                          onPress={() => { setDialCode(d.code); setDialPickerOpen(false); }}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                            padding: 14,
                            borderRadius: 12,
                            backgroundColor: pressed ? tokens.bg.elev2 : 'transparent',
                          })}
                        >
                          <Text variant="body" className="font-semibold">{d.emoji} {d.code}</Text>
                          <Text variant="body" color="secondary">{d.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </Pressable>
                </Modal>
              )}

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

              <View className="bg-neutral-50 dark:bg-neutral-900 rounded-xl px-4 py-2.5 flex-row items-center mb-8 self-start">
                <Ionicons name="call-outline" size={16} color={colors.brand.orange} />
                <Text variant="body" className="ml-2 font-semibold">{normalizedPhone}</Text>
              </View>

              <Input
                label={t('auth.otp_placeholder')}
                placeholder="000000"
                keyboardType="number-pad"
                maxLength={6}
                value={code}
                onChangeText={(v) => {
                  // UX: clear stale error as the user retypes — same pattern
                  // we use everywhere else in the auth flow.
                  if (error) setError('');
                  setCode(v);
                }}
                leftIcon={<Ionicons name="keypad-outline" size={20} color={isDark ? darkColors.text.secondary : colors.neutral[400]} />}
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

          {/* Escape hatch (Apple Guideline 2.1 / HIG escape-routes): a user who
              signed in with Google/Apple lands here with no phone, and in
              production the input only accepts +53 — so a non-Cuban reviewer
              can't send a code, can't skip, and the RootNavigator guard bounces
              them back if they try to leave. Without this they're trapped.
              Reuses the same logout footer as complete-profile. */}
          <SwitchAccountFooter />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
