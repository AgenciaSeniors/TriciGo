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
import { isValidCubanPhone, normalizeCubanPhone } from '@tricigo/utils';
import { colors } from '@tricigo/theme';

const vehicleRow = require('../../assets/vehicles/selection/triciclo.png');

export default function LoginScreen() {
  const { t } = useTranslation('common');
  const { t: td } = useTranslation('driver');
  const { isPhone } = useResponsive();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
          {/* Hero section with dark gradient */}
          <LinearGradient
            colors={['#1A1A1A', '#2D2D2D', '#1A1A1A']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ paddingTop: 80, paddingBottom: 40, paddingHorizontal: 24, borderBottomLeftRadius: 32, borderBottomRightRadius: 32 }}
          >
            <View
              style={!isPhone ? { maxWidth: 420, width: '100%', alignSelf: 'center' } : undefined}
            >
              {/* Logo */}
              <Image
                source={require('../../assets/logo-wordmark-white.png')}
                style={{ width: 200, height: 48 }}
                resizeMode="contain"
              />

              {/* Driver badge */}
              <View className="flex-row items-center mt-2 mb-1">
                <View className="bg-primary-500 px-2.5 py-1 rounded-full flex-row items-center">
                  <Ionicons name="car-sport" size={12} color="white" />
                  <Text variant="caption" color="inverse" className="ml-1 font-bold">
                    {td('common.driver_label')}
                  </Text>
                </View>
              </View>

              <Text
                variant="body"
                className="mt-2"
                style={{ color: 'rgba(255,255,255,0.5)', fontSize: 15 }}
              >
                {t('auth.driver_tagline')}
              </Text>

              {/* Vehicle illustration */}
              <View style={{ alignItems: 'flex-end', marginTop: 16 }}>
                <Image
                  source={vehicleRow}
                  style={{ width: 120, height: 120, opacity: 0.7 }}
                  resizeMode="contain"
                />
              </View>
            </View>
          </LinearGradient>

          {/* Orange accent line */}
          <LinearGradient
            colors={['#FF4D00', '#FF6B2C']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ height: 3 }}
          />

          {/* Form section */}
          <View
            className="px-6 pt-8 flex-1"
            style={!isPhone ? { maxWidth: 420, width: '100%', alignSelf: 'center' } : undefined}
          >
            {/* Welcome text */}
            <Text variant="h3" color="inverse" className="mb-1">
              {t('auth.welcome', { defaultValue: 'Bienvenido' })}
            </Text>
            <Text variant="bodySmall" color="inverse" className="mb-6 opacity-50">
              {t('auth.enter_phone_description', { defaultValue: 'Ingresa tu número para comenzar' })}
            </Text>

            {/* Phone input with country prefix */}
            <View className="flex-row items-center gap-2 mb-1">
              <View className="bg-neutral-800 rounded-xl px-3 py-3.5 flex-row items-center border border-neutral-700">
                <Text variant="body" color="inverse" className="font-semibold">🇨🇺 +53</Text>
              </View>
              <View className="flex-1">
                <Input
                  placeholder="5XXXXXXX"
                  keyboardType="phone-pad"
                  value={phone}
                  onChangeText={setPhone}
                  variant="dark"
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
              <View className="flex-1 h-px bg-neutral-700" />
              <Text variant="caption" color="inverse" className="mx-4 opacity-40">
                {t('auth.or_continue_with')}
              </Text>
              <View className="flex-1 h-px bg-neutral-700" />
            </View>

            {/* Social login buttons */}
            <View className="flex-row gap-3">
              <Pressable
                className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-2xl bg-neutral-800 border border-neutral-700 active:bg-neutral-700"
                style={{ elevation: 1, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } }}
                onPress={() => authService.signInWithGoogle()}
              >
                <Ionicons name="logo-google" size={20} color="#4285F4" />
                <Text variant="body" color="inverse" className="font-medium">Google</Text>
              </Pressable>
              <Pressable
                className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-2xl bg-white active:bg-neutral-100"
                style={{ elevation: 1, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } }}
                onPress={() => authService.signInWithApple()}
              >
                <Ionicons name="logo-apple" size={20} color="#000" />
                <Text variant="body" className="font-medium" style={{ color: '#000' }}>Apple</Text>
              </Pressable>
            </View>

            {/* Legal text */}
            <Text variant="caption" color="inverse" className="text-center mt-8 pb-8 leading-5 opacity-30">
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
