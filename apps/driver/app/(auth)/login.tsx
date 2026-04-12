import React, { useState, useRef, useEffect } from 'react';
import { View, Image, Pressable, KeyboardAvoidingView, Platform, ScrollView, Animated, Linking, Modal } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { isValidCubanPhone, normalizeCubanPhone } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

const vehicleRow = require('../../assets/vehicles/selection/triciclo.png');

export default function LoginScreen() {
  const { t } = useTranslation('common');
  const { t: td } = useTranslation('driver');
  const { isPhone } = useResponsive();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [socialLoading, setSocialLoading] = useState(false);
  const [legalType, setLegalType] = useState<'terms' | 'privacy' | null>(null);
  const { t: tWeb } = useTranslation('web');

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
    if (!isValidCubanPhone(phone)) {
      setError(t('auth.invalid_phone'));
      return;
    }

    setLoading(true);
    try {
      const normalized = normalizeCubanPhone(phone);
      await authService.sendOTP(normalized);
      router.push({ pathname: '/(auth)/verify-otp', params: { phone: normalized } });
    } catch {
      setError(t('errors.generic'));
    } finally {
      setLoading(false);
    }
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
                <Text variant="bodySmall" color="secondary" className="mt-3">
                  {t('auth.driver_tagline')}
                </Text>
              </Animated.View>

              {/* Vehicle illustration */}
              <Animated.View style={{ alignItems: 'flex-end', marginTop: 16, opacity: fadeAnim }}>
                <Image
                  source={vehicleRow}
                  style={{ width: 120, height: 120, opacity: 0.5 }}
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
            <Text variant="bodySmall" color="secondary" className="mb-6">
              {t('auth.enter_phone_description', { defaultValue: 'Ingresa tu número para comenzar' })}
            </Text>

            {/* Phone input with country prefix */}
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
                  placeholder="5XXXXXXX"
                  keyboardType="phone-pad"
                  value={phone}
                  onChangeText={setPhone}
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
              <Text variant="caption" color="secondary" className="mx-4">
                {t('auth.or_continue_with')}
              </Text>
              <View className="flex-1 h-px bg-white/6" />
            </View>

            {/* Social login buttons */}
            <View className="flex-row gap-3">
              <Pressable
                className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl bg-[#1a1a2e] border border-white/12 active:bg-[#252540] min-h-[48px]"
                disabled={socialLoading || loading}
                onPress={async () => {
                  setSocialLoading(true);
                  try {
                    const redirectTo = Platform.OS === 'web' ? window.location.origin : 'tricigo-driver://auth/callback';
                    const data = await authService.signInWithGoogle(redirectTo);
                    if (Platform.OS !== 'web' && data?.url) {
                      await Linking.openURL(data.url);
                    }
                  } catch {
                    setSocialLoading(false);
                  }
                  setTimeout(() => setSocialLoading(false), 30000);
                }}
                accessibilityRole="button"
                accessibilityLabel={t('auth.sign_in_google', { defaultValue: 'Iniciar sesión con Google' })}
              >
                <Ionicons name="logo-google" size={20} color="#4285F4" />
                <Text variant="body" color="inverse" className="font-medium">Google</Text>
              </Pressable>
              <Pressable
                className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl bg-white active:bg-neutral-100 min-h-[48px]"
                disabled={socialLoading || loading}
                onPress={async () => {
                  setSocialLoading(true);
                  try {
                    const redirectTo = Platform.OS === 'web' ? window.location.origin : 'tricigo-driver://auth/callback';
                    const data = await authService.signInWithApple(redirectTo);
                    if (Platform.OS !== 'web' && data?.url) {
                      await Linking.openURL(data.url);
                    }
                  } catch {
                    setSocialLoading(false);
                  }
                  setTimeout(() => setSocialLoading(false), 30000);
                }}
                accessibilityRole="button"
                accessibilityLabel={t('auth.sign_in_apple', { defaultValue: 'Iniciar sesión con Apple' })}
              >
                <Ionicons name="logo-apple" size={20} color="#000" />
                <Text variant="body" className="font-medium" style={{ color: '#000' }}>Apple</Text>
              </Pressable>
            </View>

            {/* Legal text */}
            <Text variant="caption" color="secondary" className="text-center mt-8 pb-8 leading-5">
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
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 50, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#333' }}>
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
                <Text variant="caption" color="secondary" className="mb-6">{tWeb('terms.last_updated')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.acceptance_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.acceptance_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.service_desc_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.service_desc_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.eligibility_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.eligibility_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.accounts_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.accounts_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.rides_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.rides_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.payments_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.payments_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.cancellations_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.cancellations_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.conduct_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6">{tWeb('terms.conduct_intro')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('terms.conduct_respectful')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('terms.conduct_laws')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('terms.conduct_no_fraud')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{'  \u2022 '}{tWeb('terms.conduct_no_damage')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.liability_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.liability_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.ip_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.ip_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.termination_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.termination_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.modifications_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.modifications_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.governing_law_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('terms.governing_law_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('terms.contact_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6">{tWeb('terms.contact_text')}</Text>
                <Text variant="body" color="accent" className="leading-6">{tWeb('terms.contact_email')}</Text>
              </>
            ) : legalType === 'privacy' ? (
              <>
                <Text variant="h2" color="inverse" className="mb-1">{tWeb('privacy.title')}</Text>
                <Text variant="caption" color="secondary" className="mb-6">{tWeb('privacy.last_updated')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.intro_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('privacy.intro_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.data_collected_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6">{tWeb('privacy.data_collected_intro')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.data_name_phone')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.data_location')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.data_ride_history')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.data_payment')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{'  \u2022 '}{tWeb('privacy.data_device')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.data_use_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6">{tWeb('privacy.data_use_intro')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.use_provide_service')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.use_improve')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.use_safety')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.use_communications')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{'  \u2022 '}{tWeb('privacy.use_legal')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.sharing_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('privacy.sharing_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.retention_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('privacy.retention_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.rights_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6">{tWeb('privacy.rights_intro')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.right_access')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.right_correction')}</Text>
                <Text variant="body" color="secondary" className="mb-1 leading-6">{'  \u2022 '}{tWeb('privacy.right_deletion')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{'  \u2022 '}{tWeb('privacy.right_portability')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.security_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('privacy.security_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.children_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('privacy.children_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.changes_title')}</Text>
                <Text variant="body" color="secondary" className="mb-4 leading-6">{tWeb('privacy.changes_text')}</Text>

                <Text variant="h3" color="inverse" className="mb-2 mt-4">{tWeb('privacy.contact_title')}</Text>
                <Text variant="body" color="secondary" className="mb-2 leading-6">{tWeb('privacy.contact_text')}</Text>
                <Text variant="body" color="accent" className="leading-6">{tWeb('privacy.contact_email')}</Text>
              </>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
