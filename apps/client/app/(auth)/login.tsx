import React, { useState } from 'react';
import { View, Image, Pressable, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
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
import { colors } from '@tricigo/theme';

const vehicleRow = require('../../assets/vehicles/selection/triciclo.png');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginScreen() {
  const { t } = useTranslation('common');
  const { isPhone } = useResponsive();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSendCode = async () => {
    setError('');

    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(trimmed)) {
      setError(t('auth.invalid_email', { defaultValue: 'Ingresa un correo válido' }));
      return;
    }

    setLoading(true);
    try {
      await authService.sendOTP(trimmed);
      router.push({ pathname: '/(auth)/verify-otp', params: { email: trimmed } });
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
              {t('auth.enter_email_description', { defaultValue: 'Ingresa tu correo para comenzar' })}
            </Text>

            {/* Email input */}
            <Input
              placeholder={t('auth.email_placeholder', { defaultValue: 'tucorreo@ejemplo.com' })}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
              leftIcon={<Ionicons name="mail-outline" size={20} color={colors.neutral[400]} />}
              autoFocus
            />

            {error ? (
              <Text variant="bodySmall" color="error" className="mb-2">
                {error}
              </Text>
            ) : null}

            <Button
              title={t('auth.send_code')}
              onPress={handleSendCode}
              loading={loading}
              disabled={!EMAIL_REGEX.test(email.trim()) || loading}
              fullWidth
              size="lg"
              className="mt-2"
            />

            {/* Divider */}
            <View className="flex-row items-center my-6">
              <View className="flex-1 h-px bg-neutral-200" />
              <Text variant="caption" color="tertiary" className="mx-4">
                {t('auth.or_continue_with', { defaultValue: 'o continúa con' })}
              </Text>
              <View className="flex-1 h-px bg-neutral-200" />
            </View>

            {/* Social login buttons */}
            <View className="flex-row gap-3">
              <Pressable
                className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-2xl bg-neutral-50 border border-neutral-200 active:bg-neutral-100"
                style={{ elevation: 1, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, opacity: socialLoading ? 0.5 : 1 }}
                disabled={socialLoading || loading}
                onPress={async () => { setSocialLoading(true); try { await authService.signInWithGoogle(Platform.OS === 'web' ? window.location.origin : undefined); } catch { setSocialLoading(false); } }}
              >
                <Ionicons name="logo-google" size={20} color="#4285F4" />
                <Text variant="body" className="font-medium">{socialLoading ? '...' : 'Google'}</Text>
              </Pressable>
              <Pressable
                className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-2xl bg-neutral-900 active:bg-neutral-800"
                style={{ elevation: 1, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, opacity: socialLoading ? 0.5 : 1 }}
                disabled={socialLoading || loading}
                onPress={async () => { setSocialLoading(true); try { await authService.signInWithApple(Platform.OS === 'web' ? window.location.origin : undefined); } catch { setSocialLoading(false); } }}
              >
                <Ionicons name="logo-apple" size={20} color="#fff" />
                <Text variant="body" className="font-medium" style={{ color: '#fff' }}>{socialLoading ? '...' : 'Apple'}</Text>
              </Pressable>
            </View>

            {/* Legal text */}
            <Text variant="caption" color="tertiary" className="text-center mt-8 pb-8 leading-5">
              {t('auth.terms_notice', { defaultValue: 'Al continuar, aceptas nuestros' })}{' '}
              <Text variant="caption" color="accent" className="underline">
                {t('auth.terms_link', { defaultValue: 'Términos de Servicio' })}
              </Text>
              {' '}{t('auth.and', { defaultValue: 'y' })}{' '}
              <Text variant="caption" color="accent" className="underline">
                {t('auth.privacy_link', { defaultValue: 'Política de Privacidad' })}
              </Text>
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
