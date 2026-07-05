import React, { useState, useRef, useEffect } from 'react';
import { View, Image, Pressable, KeyboardAvoidingView, Platform, ScrollView, Animated, Linking, Modal } from 'react-native';
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
import { isValidCubanPhone, normalizeCubanPhone } from '@tricigo/utils';
import { colors, midnightEmber } from '@tricigo/theme';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

const vehicleRow = require('../../assets/login-hero.png');

// Sign in with Apple uses the NATIVE iOS sheet (expo-apple-authentication) +
// Supabase signInWithIdToken — the flow Apple requires on iOS (App Store
// Guideline 4.8: offer it when another third-party sign-in like Google is
// shown). The button is gated on native availability (`appleAvailable`), so it
// only renders on iOS where Sign in with Apple is supported. The legacy web
// OAuth `authService.signInWithApple` stays for the web app only.

// BUG-201 fallback: openAuthSessionAsync can return the redirect URL without
// the OS ever firing the Linking event, so useAuthDeepLink never runs and the
// session is silently lost. Parse the tokens out of the returned URL and set
// the session manually.
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
  const { t: td } = useTranslation('driver');
  const { isPhone } = useResponsive();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [socialLoading, setSocialLoading] = useState(false);
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

  // Entrance animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, damping: 20, stiffness: 200, mass: 1, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  const handleSendCode = async () => {
    setError('');
    const isValid = isValidCubanPhone(phone);
    if (!isValid) {
      setError(t('auth.invalid_phone'));
      // UX: on larger screens the inline red message can sit outside the
      // keyboard-focused viewport — user hits the disabled Send button and
      // nothing appears to happen. Toast reinforces visibility.
      Toast.show({
        type: 'error',
        text1: t('auth.invalid_phone'),
        visibilityTime: 2500,
      });
      return;
    }

    setLoading(true);
    try {
      const normalized = normalizeCubanPhone(phone);
      await authService.sendOTP(normalized);
      router.push({ pathname: '/(auth)/verify-otp', params: { phone: normalized } });
    } catch {
      setError(t('errors.generic'));
      Toast.show({ type: 'error', text1: t('errors.generic'), visibilityTime: 2500 });
    } finally {
      setLoading(false);
    }
  };

  // UX: clear error as soon as the user starts editing. Without this, old
  // red error text hangs around while they retype, even though the input
  // now looks valid.
  const handlePhoneChange = (v: string) => {
    setPhone(v);
    if (error) setError('');
  };

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Hero section — deep dark premium gradient */}
          <LinearGradient
            colors={['#0a0a0f', '#1a1a2e', '#0a0a0f']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ paddingTop: 60, paddingBottom: 40, paddingHorizontal: 24, borderBottomLeftRadius: 32, borderBottomRightRadius: 32 }}
          >
            <View
              style={!isPhone ? { maxWidth: 420, width: '100%', alignSelf: 'center' } : undefined}
            >
              {/* Top row: Logo + Language Switcher */}
              <View className="flex-row items-center justify-between mb-3">
                <Image
                  source={require('../../assets/logo-wordmark-white.png')}
                  style={{ width: 160, height: 40 }}
                  resizeMode="contain"
                  accessibilityLabel="TriciGo"
                />
                <LanguageSwitcher variant="pill" />
              </View>

              {/* Driver badge */}
              <View className="flex-row items-center mt-2 mb-1">
                <View className="bg-primary-500 px-3 py-1.5 rounded-full flex-row items-center">
                  <Ionicons name="car-sport" size={13} color="white" />
                  <Text variant="badge" color="inverse" className="ml-1.5 font-bold uppercase tracking-wider">
                    {td('common.driver_label')}
                  </Text>
                </View>
              </View>

              <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
                <Text variant="bodySmall" color="secondary" className="mt-3" style={{ color: midnightEmber.map.text.secondary }}>
                  {t('auth.driver_tagline')}
                </Text>
              </Animated.View>

              {/* Vehicle illustration — small, subtle, right-aligned (hi-res, gaps cleaned) */}
              <Animated.View style={{ alignItems: 'flex-end', marginTop: 16, opacity: fadeAnim }}>
                <Image
                  source={vehicleRow}
                  style={{ width: 250, height: 95, opacity: 1 }}
                  resizeMode="contain"
                />
              </Animated.View>
            </View>
          </LinearGradient>

          {/* Orange accent line */}
          <LinearGradient
            colors={[colors.brand.orange, '#FF6B2C']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ height: 3 }}
          />

          {/* Form section */}
          <Animated.View
            className="px-6 pt-8 flex-1"
            style={[
              !isPhone ? { maxWidth: 420, width: '100%', alignSelf: 'center' } : undefined,
              { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
            ]}
          >
            {/* Welcome text */}
            <Text variant="h3" color="inverse" className="mb-1">
              {t('auth.welcome', { defaultValue: 'Bienvenido' })}
            </Text>
            <Text variant="bodySmall" color="secondary" className="mb-6" style={{ color: midnightEmber.map.text.secondary }}>
              {t('auth.enter_phone_description', { defaultValue: 'Ingresa tu número para comenzar' })}
            </Text>

            {/* Phone input with fixed Cuba +53 country prefix. */}
            <View className="flex-row items-center gap-2 mb-1">
              <View
                className="bg-[#1a1a2e] rounded-xl px-3 py-3.5 flex-row items-center border border-white/12"
                accessible
                accessibilityLabel="Cuba +53"
                accessibilityRole="text"
              >
                <Ionicons name="flag" size={14} color={colors.brand.orange} />
                <Text variant="body" color="inverse" className="font-semibold ml-1.5">+53</Text>
              </View>
              <View className="flex-1">
                <Input
                  placeholder="5XXXXXXX o 6XXXXXXX"
                  keyboardType="phone-pad"
                  value={phone}
                  onChangeText={handlePhoneChange}
                  variant="dark"
                  autoFocus
                  accessibilityLabel={t('auth.phone_input_label', { defaultValue: 'Número de teléfono' })}
                />
              </View>
            </View>

            {error ? (
              <Text variant="bodySmall" color="error" className="mb-2">
                {error}
              </Text>
            ) : null}

            <Button
              title={t('auth.send_code')}
              onPress={handleSendCode}
              loading={loading}
              disabled={phone.length < 7 || loading}
              fullWidth
              size="lg"
              className="mt-3"
            />

            {/* Divider */}
            <View className="flex-row items-center my-6">
              <View className="flex-1 h-px bg-white/6" />
              <Text variant="caption" color="secondary" className="mx-4" style={{ color: midnightEmber.map.text.secondary }}>
                {t('auth.or_continue_with')}
              </Text>
              <View className="flex-1 h-px bg-white/6" />
            </View>

            {/* Social login buttons — stacked full-width so each shows the
                HIG-required label with its logo, at equal size/prominence
                (Apple Review Guideline 4.8). Dark-only screen: Apple button is
                the white HIG variant on the dark background. */}
            <View className="gap-3">
              <Pressable
                className="flex-row items-center justify-center gap-2 rounded-2xl bg-[#1a1a2e] border border-white/12 active:bg-[#252540] min-h-[52px]"
                disabled={socialLoading || loading}
                onPress={async () => {
                  setSocialLoading(true);
                  try {
                    const redirectTo = Platform.OS === 'web' ? window.location.origin : 'tricigo-driver://auth/callback';
                    console.log('[GoogleSignIn] redirectTo', redirectTo);
                    const data = await authService.signInWithGoogle(redirectTo);
                    console.log('[GoogleSignIn] supabase data', { hasUrl: !!data?.url, urlPrefix: data?.url?.slice(0, 80) });
                    if (Platform.OS !== 'web' && data?.url) {
                      // BUG-201/202 (1+2): openAuthSessionAsync auto-closes when
                      // the URL matches `redirectTo`. If the user reports the
                      // sheet not closing, the result.type/url logged below
                      // tells us whether: (a) we never received the redirect
                      // ('cancel'/'dismiss') — likely scheme not registered
                      // properly, or (b) we got a different URL — Supabase or
                      // Google sent us elsewhere.
                      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
                      console.log('[GoogleSignIn] WebBrowser result', { type: result.type, url: 'url' in result ? result.url : null });
                      // BUG-201 fallback: if browser returned with a callback URL
                      // but the OS-level handler didn't fire the Linking event,
                      // process the URL manually so the session is set anyway.
                      await setSessionFromAuthResult(result);
                    }
                  } catch (err) {
                    console.warn('[GoogleSignIn] error', String(err));
                    setSocialLoading(false);
                    // Surface the failure instead of silently resetting the
                    // spinner — a dead-looking social button reads as a bug to
                    // store reviewers and confuses users on a real network error.
                    Toast.show({
                      type: 'error',
                      text1: t('auth.social_login_failed_title', { defaultValue: 'No se pudo iniciar sesión' }),
                      text2: t('auth.social_login_failed_body', { defaultValue: 'Probá de nuevo o usá tu número de teléfono.' }),
                      visibilityTime: 3000,
                    });
                  }
                  setTimeout(() => setSocialLoading(false), 30000);
                }}
                accessibilityRole="button"
                accessibilityLabel={t('auth.sign_in_google', { defaultValue: 'Iniciar sesión con Google' })}
              >
                <Ionicons name="logo-google" size={20} color="#4285F4" />
                <Text variant="body" color="inverse" className="font-medium">{socialLoading ? '...' : t('auth.continue_with_google', { defaultValue: 'Continuar con Google' })}</Text>
              </Pressable>
              {(appleAvailable || Platform.OS === 'android') && (
              <Pressable
                className="flex-row items-center justify-center gap-2 rounded-2xl bg-white active:bg-neutral-100 min-h-[52px]"
                disabled={socialLoading || loading}
                onPress={async () => {
                  setSocialLoading(true);
                  try {
                    if (appleAvailable) {
                      // iOS: native Sign in with Apple sheet → exchange the
                      // identity token. The auth listener picks up SIGNED_IN
                      // and routes — no manual redirect handling.
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
                      // tricigo-driver:// deep link; BUG-201 fallback sets session.
                      const redirectTo = 'tricigo-driver://auth/callback';
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
                    Toast.show({
                      type: 'error',
                      text1: t('auth.social_login_failed_title', { defaultValue: 'No se pudo iniciar sesión' }),
                      text2: t('auth.social_login_failed_body', { defaultValue: 'Probá de nuevo o usá tu número de teléfono.' }),
                      visibilityTime: 3000,
                    });
                  }
                  setTimeout(() => setSocialLoading(false), 30000);
                }}
                accessibilityRole="button"
                accessibilityLabel={t('auth.sign_in_apple', { defaultValue: 'Iniciar sesión con Apple' })}
              >
                <Ionicons name="logo-apple" size={20} color="#000" />
                <Text variant="body" className="font-medium" style={{ color: '#000' }}>{socialLoading ? '...' : t('auth.continue_with_apple', { defaultValue: 'Continuar con Apple' })}</Text>
              </Pressable>
              )}
            </View>

            {/* Legal text */}
            <Text variant="caption" color="secondary" className="text-center mt-8 pb-8 leading-5" style={{ color: midnightEmber.map.text.secondary }}>
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
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Legal Content Modal */}
      <Modal visible={!!legalType} animationType="slide" onRequestClose={() => setLegalType(null)}>
        <View style={{ flex: 1, backgroundColor: '#111' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: insets.top + 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#333' }}>
            <Text variant="body" color="inverse" className="font-semibold">
              {legalType === 'terms' ? t('auth.terms_link', { defaultValue: 'Términos de Servicio' }) : t('auth.privacy_link', { defaultValue: 'Política de Privacidad' })}
            </Text>
            <Pressable onPress={() => setLegalType(null)} hitSlop={12}>
              <Ionicons name="close" size={24} color="#fff" />
            </Pressable>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
            {legalType === 'terms' ? (
              <>
                <Text variant="h2" color="inverse" className="mb-1">{tWeb('terms.title')}</Text>
                <Text variant="caption" color="secondary" className="mb-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.last_updated')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.acceptance_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.acceptance_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.service_desc_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.service_desc_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.eligibility_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.eligibility_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.accounts_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.accounts_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.rides_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.rides_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.payments_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.payments_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.cancellations_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.cancellations_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.conduct_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.conduct_intro')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('terms.conduct_respectful')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('terms.conduct_laws')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('terms.conduct_no_fraud')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('terms.conduct_no_damage')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.liability_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.liability_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.ip_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.ip_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.termination_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.termination_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.modifications_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.modifications_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.governing_law_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.governing_law_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.contact_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('terms.contact_text')}</Text>
                <Text variant="body" color="accent" className="leading-6">{tWeb('terms.contact_email')}</Text>
              </>
            ) : legalType === 'privacy' ? (
              <>
                <Text variant="h2" color="inverse" className="mb-1">{tWeb('privacy.title')}</Text>
                <Text variant="caption" color="secondary" className="mb-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.last_updated')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.intro_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.intro_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.data_collected_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.data_collected_intro')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.data_name_phone')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.data_location')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.data_ride_history')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.data_payment')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.data_device')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.data_use_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.data_use_intro')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.use_provide_service')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.use_improve')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.use_safety')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.use_communications')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.use_legal')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.sharing_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.sharing_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.retention_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.retention_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.rights_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.rights_intro')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.right_access')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.right_correction')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.right_deletion')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{'  \u2022 '}{tWeb('privacy.right_portability')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.security_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.security_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.children_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.children_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.changes_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.changes_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.contact_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6" style={{ color: midnightEmber.map.text.secondary }}>{tWeb('privacy.contact_text')}</Text>
                <Text variant="body" color="accent" className="leading-6">{tWeb('privacy.contact_email')}</Text>
              </>
            ) : null}
          </ScrollView>
        </View>
      </Modal>

    </Screen>
  );
}
