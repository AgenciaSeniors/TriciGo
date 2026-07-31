import React, { useState, useEffect } from 'react';
import { View, Image, Pressable, KeyboardAvoidingView, Platform, ScrollView, Linking, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import { useTranslation } from '@tricigo/i18n';
import { authService, getSupabaseClient } from '@tricigo/api';
import { isValidCubanPhone, normalizeCubanPhone, triggerHaptic } from '@tricigo/utils';
import {
  DEMO_MODE,
  DEMO_DIAL_CODES,
  isValidDemoPhone,
  normalizeDemoPhone,
} from '@/config/demo';
import { useThemeStore } from '@/stores/theme.store';
import { useTokens } from '@/hooks/useTokens';

const vehicleRow = require('../../assets/login-hero.png');

// Sign in with Apple uses the NATIVE iOS sheet (expo-apple-authentication) +
// Supabase signInWithIdToken — the flow Apple requires on iOS (App Store
// Guideline 4.8: offer it when another third-party sign-in like Google is
// shown). The button is gated on native availability (`appleAvailable`), so it
// only renders on iOS where Sign in with Apple is supported. The legacy web
// OAuth `authService.signInWithApple` stays for the web app only.

// BUG-201 fallback (parity with the driver app): openAuthSessionAsync can
// return the redirect URL without the OS ever firing the Linking event, so
// useDeepLinkHandler never runs and the session is silently lost. Parse the
// tokens out of the returned URL and set the session manually.
async function setSessionFromAuthResult(result: WebBrowser.WebBrowserAuthSessionResult) {
  if (result.type !== 'success' || !('url' in result) || !result.url?.includes('auth/callback')) return;
  const hashIdx = result.url.indexOf('#');
  if (hashIdx < 0) return;
  const params = new URLSearchParams(result.url.substring(hashIdx + 1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) {
    const supabase = getSupabaseClient();
    await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    console.log('[OAuth] Session set from openAuthSessionAsync result');
  }
}

export default function LoginScreen() {
  const { t } = useTranslation('common');
  // The legal-viewer Modal below is full-screen and does not inherit any
  // SafeAreaView — its header needs the real top inset (Dynamic Island).
  const insets = useSafeAreaInsets();
  const { isPhone } = useResponsive();
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const tokens = useTokens();
  const isDark = resolvedScheme === 'dark';
  const [phone, setPhone] = useState('');
  const [dialCode, setDialCode] = useState<string>(
    DEMO_MODE ? DEMO_DIAL_CODES[0]!.code : '+53',
  );
  const [dialPickerOpen, setDialPickerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState(false);
  const [error, setError] = useState('');
  const [legalType, setLegalType] = useState<'terms' | 'privacy' | null>(null);
  const { t: tWeb } = useTranslation('web');

  // Sign in with Apple: iOS uses the NATIVE sheet (expo-apple-authentication),
  // detected via `appleAvailable`. Android has no native module, so it falls
  // back to the web OAuth flow in an in-app browser (same as Google). The button
  // renders on iOS (native) and Android (web OAuth); it stays hidden on Expo web.
  const [appleAvailable, setAppleAvailable] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    AppleAuthentication.isAvailableAsync()
      .then(setAppleAvailable)
      .catch(() => setAppleAvailable(false));
  }, []);

  const handleSendCode = async () => {
    setError('');

    // Demo mode: permissive validation + use picked dial code.
    // Prod: strict Cuban format.
    const isValid = DEMO_MODE ? isValidDemoPhone(phone) : isValidCubanPhone(phone);
    if (!isValid) {
      setError(t('auth.invalid_phone'));
      return;
    }

    const normalized = DEMO_MODE
      ? normalizeDemoPhone(phone, dialCode)
      : normalizeCubanPhone(phone);
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
    <Screen bg="white" padded={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Hero section with gradient — vibrant orange in light,
              muted deeper oranges in dark to keep brand without
              clashing with the dark scheme. */}
          <LinearGradient
            colors={
              isDark
                ? ['#8B2900', '#B53600', '#FF4D00']
                : ['#FF4D00', '#FF6B2C', '#FF8F5C']
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ paddingTop: 80, paddingBottom: 40, paddingHorizontal: 24, borderBottomLeftRadius: 32, borderBottomRightRadius: 32 }}
          >
            <View
              style={!isPhone ? { maxWidth: 420, width: '100%', alignSelf: 'center' } : undefined}
            >
              {/* Logo */}
              <Image
                source={require('../../assets/logo-wordmark.png')}
                style={{ width: 200, height: 48, tintColor: '#fff' }}
                resizeMode="contain"
              />
              <Text
                variant="body"
                className="mt-3"
                style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16 }}
              >
                {t('auth.tagline', { defaultValue: 'Tu plataforma de movilidad en La Habana' })}
              </Text>

              {/* Vehicle illustration — small, subtle, right-aligned (hi-res, gaps cleaned) */}
              <View style={{ alignItems: 'flex-end', marginTop: 16 }}>
                <Image
                  source={vehicleRow}
                  style={{ width: 250, height: 93, opacity: 0.9 }}
                  resizeMode="contain"
                />
              </View>
            </View>
          </LinearGradient>

          {/* Form section */}
          <View
            className="px-6 pt-8 flex-1"
            style={!isPhone ? { maxWidth: 420, width: '100%', alignSelf: 'center' } : undefined}
          >
            {/* Welcome text */}
            <Text variant="h3" className="mb-1">
              {t('auth.welcome', { defaultValue: 'Bienvenido' })}
            </Text>
            <Text variant="bodySmall" color="secondary" className="mb-6">
              {t('auth.enter_phone_description', { defaultValue: 'Ingresa tu número para comenzar' })}
            </Text>

            {/* Phone input with country prefix.
                In demo mode the prefix is a picker (BR/CU); in prod
                it stays fixed at +53 Cuba. */}
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
                  <Ionicons name="chevron-down" size={14} color="#6B7F8F" />
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
              <Text variant="bodySmall" color="error" className="mb-2">
                {error}
              </Text>
            ) : null}

            <Button
              title={t('auth.send_code')}
              /* UX: instead of a silently-disabled button (user taps and
                 nothing happens), accept the tap and nudge with a toast
                 when the phone is too short. Same pattern we use in
                 driver rounds so the user always gets feedback. */
              onPress={() => {
                if (phone.length < 7) {
                  triggerHaptic('warning');
                  Toast.show({
                    type: 'info',
                    text1: t('auth.phone_too_short_title', { defaultValue: 'Teléfono incompleto' }),
                    text2: t('auth.phone_too_short_body', { defaultValue: 'Ingresa el número completo para recibir el código.' }),
                    visibilityTime: 2500,
                  });
                  return;
                }
                handleSendCode();
              }}
              loading={loading}
              disabled={loading}
              fullWidth
              size="lg"
              className="mt-2"
            />

            {/* Divider */}
            <View className="flex-row items-center my-6">
              <View className="flex-1 h-px bg-neutral-200 dark:bg-neutral-700" />
              <Text variant="caption" color="tertiary" className="mx-4">
                {t('auth.or_continue_with', { defaultValue: 'o continúa con' })}
              </Text>
              <View className="flex-1 h-px bg-neutral-200 dark:bg-neutral-700" />
            </View>

            {/* Social login buttons — stacked full-width so each shows the
                HIG-required label with its logo, and Sign in with Apple sits at
                equal size/prominence to Google (Apple Review Guideline 4.8).
                Apple button is black on light / white on dark per the HIG. */}
            <View className="gap-3">
              <Pressable
                className="flex-row items-center justify-center gap-2 py-4 rounded-2xl bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 active:bg-neutral-100 dark:active:bg-neutral-700"
                style={{ elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, opacity: socialLoading ? 0.5 : 1 }}
                disabled={socialLoading || loading}
                onPress={async () => {
                  setSocialLoading(true);
                  try {
                    const redirectTo = Platform.OS === 'web'
                      ? window.location.origin
                      : 'tricigo://auth/callback';
                    const data = await authService.signInWithGoogle(redirectTo);
                    // BUG-201/202 (1+2): use openAuthSessionAsync (in-app
                    // ASWebAuthenticationSession / Custom Tabs) so the OAuth
                    // sheet auto-closes when the redirect fires and doesn't
                    // expose the raw Supabase URL as the browser title.
                    if (Platform.OS !== 'web' && data?.url) {
                      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
                      await setSessionFromAuthResult(result);
                    }
                  } catch {
                    setSocialLoading(false);
                    // Surface the failure instead of silently resetting the
                    // spinner — a dead-looking social button reads as a bug to
                    // store reviewers and confuses users on a real network error.
                    triggerHaptic('warning');
                    Toast.show({
                      type: 'error',
                      text1: t('auth.social_login_failed_title', { defaultValue: 'No se pudo iniciar sesión' }),
                      text2: t('auth.social_login_failed_body', { defaultValue: 'Prueba de nuevo o usa tu número de teléfono.' }),
                      visibilityTime: 3000,
                    });
                  }
                  setTimeout(() => setSocialLoading(false), 30000);
                }}
              >
                <Ionicons name="logo-google" size={20} color="#4285F4" />
                <Text variant="body" className="font-medium">{socialLoading ? '...' : t('auth.continue_with_google', { defaultValue: 'Continuar con Google' })}</Text>
              </Pressable>
              {(appleAvailable || Platform.OS === 'android') && (
              <Pressable
                className="flex-row items-center justify-center gap-2 py-4 rounded-2xl bg-neutral-900 dark:bg-white active:bg-neutral-800 dark:active:bg-neutral-100"
                style={{ elevation: 1, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, opacity: socialLoading ? 0.5 : 1 }}
                disabled={socialLoading || loading}
                onPress={async () => {
                  setSocialLoading(true);
                  try {
                    if (appleAvailable) {
                      // iOS: native Sign in with Apple sheet → exchange the
                      // identity token. The auth listener (useAuth) picks up
                      // SIGNED_IN and routes — no manual redirect handling.
                      const credential = await AppleAuthentication.signInAsync({
                        requestedScopes: [
                          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                          AppleAuthentication.AppleAuthenticationScope.EMAIL,
                        ],
                      });
                      if (!credential.identityToken) throw new Error('No Apple identity token');
                      await authService.signInWithAppleIdToken(credential.identityToken);
                    } else {
                      // Android: no native Apple module — use the web OAuth flow
                      // in an in-app browser, mirroring Google. Returns via the
                      // tricigo:// deep link; BUG-201 fallback sets the session.
                      const redirectTo = 'tricigo://auth/callback';
                      const data = await authService.signInWithApple(redirectTo);
                      if (data?.url) {
                        const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
                        await setSessionFromAuthResult(result);
                      }
                    }
                  } catch (err) {
                    setSocialLoading(false);
                    // User dismissed the native Apple sheet — not an error, stay quiet.
                    if ((err as { code?: string })?.code === 'ERR_REQUEST_CANCELED') return;
                    triggerHaptic('warning');
                    Toast.show({
                      type: 'error',
                      text1: t('auth.social_login_failed_title', { defaultValue: 'No se pudo iniciar sesión' }),
                      text2: t('auth.social_login_failed_body', { defaultValue: 'Prueba de nuevo o usa tu número de teléfono.' }),
                      visibilityTime: 3000,
                    });
                  }
                  setTimeout(() => setSocialLoading(false), 30000);
                }}
              >
                <Ionicons name="logo-apple" size={20} color={isDark ? '#000' : '#fff'} />
                <Text variant="body" className="font-medium" style={{ color: isDark ? '#000' : '#fff' }}>{socialLoading ? '...' : t('auth.continue_with_apple', { defaultValue: 'Continuar con Apple' })}</Text>
              </Pressable>
              )}
            </View>

            {/* Legal text */}
            <Text variant="caption" color="tertiary" className="text-center mt-8 pb-8 leading-5">
              {t('auth.terms_notice', { defaultValue: 'Al continuar, aceptas nuestros' })}{' '}
              <Text
                variant="caption"
                color="accent"
                className="underline"
                onPress={() => setLegalType('terms')}
                accessibilityRole="link"
              >
                {t('auth.terms_link', { defaultValue: 'Términos de Servicio' })}
              </Text>
              {' '}{t('auth.and', { defaultValue: 'y' })}{' '}
              <Text
                variant="caption"
                color="accent"
                className="underline"
                onPress={() => setLegalType('privacy')}
                accessibilityRole="link"
              >
                {t('auth.privacy_link', { defaultValue: 'Política de Privacidad' })}
              </Text>
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Legal Content Modal */}
      <Modal visible={!!legalType} animationType="slide" onRequestClose={() => setLegalType(null)}>
        <View style={{ flex: 1, backgroundColor: tokens.bg.paper }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: insets.top + 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: tokens.line }}>
            <Text variant="body" className="font-semibold" style={{ color: tokens.ink.primary }}>
              {legalType === 'terms' ? t('auth.terms_link', { defaultValue: 'Términos de Servicio' }) : t('auth.privacy_link', { defaultValue: 'Política de Privacidad' })}
            </Text>
            <Pressable onPress={() => setLegalType(null)} hitSlop={12}>
              <Ionicons name="close" size={24} color={tokens.ink.secondary} />
            </Pressable>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
            {legalType === 'terms' ? (
              <>
                <Text variant="h2" className="mb-1">{tWeb('terms.title')}</Text>
                <Text variant="caption" color="tertiary" className="mb-6">{tWeb('terms.last_updated')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.acceptance_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.acceptance_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.service_desc_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.service_desc_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.eligibility_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.eligibility_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.accounts_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.accounts_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.rides_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.rides_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.payments_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.payments_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.cancellations_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.cancellations_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.conduct_title')}</Text>
                <Text variant="body" className="mb-2 leading-6">{tWeb('terms.conduct_intro')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('terms.conduct_respectful')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('terms.conduct_laws')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('terms.conduct_no_fraud')}</Text>
                <Text variant="body" className="mb-4 leading-6">{'  \u2022 '}{tWeb('terms.conduct_no_damage')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.liability_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.liability_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.ip_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.ip_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.termination_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.termination_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.modifications_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.modifications_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.governing_law_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('terms.governing_law_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('terms.contact_title')}</Text>
                <Text variant="body" className="mb-2 leading-6">{tWeb('terms.contact_text')}</Text>
                <Text variant="body" color="accent" className="leading-6">{tWeb('terms.contact_email')}</Text>
              </>
            ) : legalType === 'privacy' ? (
              <>
                <Text variant="h2" className="mb-1">{tWeb('privacy.title')}</Text>
                <Text variant="caption" color="tertiary" className="mb-6">{tWeb('privacy.last_updated')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('privacy.intro_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('privacy.intro_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('privacy.data_collected_title')}</Text>
                <Text variant="body" className="mb-2 leading-6">{tWeb('privacy.data_collected_intro')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.data_name_phone')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.data_location')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.data_ride_history')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.data_payment')}</Text>
                <Text variant="body" className="mb-4 leading-6">{'  \u2022 '}{tWeb('privacy.data_device')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('privacy.data_use_title')}</Text>
                <Text variant="body" className="mb-2 leading-6">{tWeb('privacy.data_use_intro')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.use_provide_service')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.use_improve')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.use_safety')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.use_communications')}</Text>
                <Text variant="body" className="mb-4 leading-6">{'  \u2022 '}{tWeb('privacy.use_legal')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('privacy.sharing_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('privacy.sharing_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('privacy.retention_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('privacy.retention_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('privacy.rights_title')}</Text>
                <Text variant="body" className="mb-2 leading-6">{tWeb('privacy.rights_intro')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.right_access')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.right_correction')}</Text>
                <Text variant="body" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.right_deletion')}</Text>
                <Text variant="body" className="mb-4 leading-6">{'  \u2022 '}{tWeb('privacy.right_portability')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('privacy.security_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('privacy.security_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('privacy.children_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('privacy.children_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('privacy.changes_title')}</Text>
                <Text variant="body" className="mb-4 leading-6">{tWeb('privacy.changes_text')}</Text>

                <Text variant="h3" className="mb-2 mt-4">{tWeb('privacy.contact_title')}</Text>
                <Text variant="body" className="mb-2 leading-6">{tWeb('privacy.contact_text')}</Text>
                <Text variant="body" color="accent" className="leading-6">{tWeb('privacy.contact_email')}</Text>
              </>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
