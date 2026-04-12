import React, { useState } from 'react';
import { View, Image, Pressable, KeyboardAvoidingView, Platform, ScrollView, Linking, Modal } from 'react-native';
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

const vehicleRow = require('../../assets/vehicles/selection/triciclo.png');

export default function LoginScreen() {
  const { t } = useTranslation('common');
  const { isPhone } = useResponsive();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState(false);
  const [error, setError] = useState('');
  const [legalType, setLegalType] = useState<'terms' | 'privacy' | null>(null);
  const { t: tWeb } = useTranslation('web');

  const handleSendCode = async () => {
    setError('');

    if (!isValidCubanPhone(phone)) {
      setError(t('auth.invalid_phone'));
      return;
    }

    const normalized = normalizeCubanPhone(phone);
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
          {/* Hero section with gradient */}
          <LinearGradient
            colors={['#FF4D00', '#FF6B2C', '#FF8F5C']}
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

              {/* Vehicle illustration */}
              <View style={{ alignItems: 'flex-end', marginTop: 16 }}>
                <Image
                  source={vehicleRow}
                  style={{ width: 120, height: 120, opacity: 0.9 }}
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

            {/* Phone input with country prefix */}
            <View className="flex-row items-center gap-2 mb-1">
              <View className="bg-neutral-100 dark:bg-neutral-800 rounded-xl px-3 py-3.5 flex-row items-center">
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

            {/* Social login buttons */}
            <View className="flex-row gap-3">
              <Pressable
                className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-2xl bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 active:bg-neutral-100 dark:active:bg-neutral-700"
                style={{ elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, opacity: socialLoading ? 0.5 : 1 }}
                disabled={socialLoading || loading}
                onPress={async () => {
                  setSocialLoading(true);
                  try {
                    const redirectTo = Platform.OS === 'web'
                      ? window.location.origin
                      : 'tricigo://auth/callback';
                    const data = await authService.signInWithGoogle(redirectTo);
                    // On native, signInWithOAuth returns { url } — must open browser manually
                    if (Platform.OS !== 'web' && data?.url) {
                      await Linking.openURL(data.url);
                    }
                  } catch {
                    setSocialLoading(false);
                  }
                  setTimeout(() => setSocialLoading(false), 30000);
                }}
              >
                <Ionicons name="logo-google" size={20} color="#4285F4" />
                <Text variant="body" className="font-medium">{socialLoading ? '...' : 'Google'}</Text>
              </Pressable>
              <Pressable
                className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-2xl bg-neutral-900 active:bg-neutral-800"
                style={{ elevation: 1, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, opacity: socialLoading ? 0.5 : 1 }}
                disabled={socialLoading || loading}
                onPress={async () => {
                  setSocialLoading(true);
                  try {
                    const redirectTo = Platform.OS === 'web'
                      ? window.location.origin
                      : 'tricigo://auth/callback';
                    const data = await authService.signInWithApple(redirectTo);
                    if (Platform.OS !== 'web' && data?.url) {
                      await Linking.openURL(data.url);
                    }
                  } catch {
                    setSocialLoading(false);
                  }
                  setTimeout(() => setSocialLoading(false), 30000);
                }}
              >
                <Ionicons name="logo-apple" size={20} color="#fff" />
                <Text variant="body" className="font-medium" style={{ color: '#fff' }}>{socialLoading ? '...' : 'Apple'}</Text>
              </Pressable>
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
        <View style={{ flex: 1, backgroundColor: '#fff' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 50, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#e5e5e5' }}>
            <Text variant="body" className="font-semibold">
              {legalType === 'terms' ? t('auth.terms_link', { defaultValue: 'Términos de Servicio' }) : t('auth.privacy_link', { defaultValue: 'Política de Privacidad' })}
            </Text>
            <Pressable onPress={() => setLegalType(null)} hitSlop={12}>
              <Ionicons name="close" size={24} color="#333" />
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
