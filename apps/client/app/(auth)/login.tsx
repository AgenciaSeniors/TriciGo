import React, { useState } from 'react';
import { View, Image, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { isValidCubanPhone, normalizeCubanPhone } from '@tricigo/utils';
import { colors } from '@tricigo/theme';

export default function LoginScreen() {
  const { t } = useTranslation('common');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
      {/* Top decorative accent */}
      <View className="absolute top-0 left-0 right-0 h-48 bg-primary-50 rounded-b-3xl opacity-60" />

      <View className="flex-1 justify-center px-6">
        {/* Logo + Tagline */}
        <Image
          source={require('../../assets/logo-wordmark.png')}
          style={{ width: 260, height: 62 }}
          resizeMode="contain"
          className="mb-3"
        />
        <Text variant="bodySmall" color="secondary" className="mb-10">
          {t('auth.tagline', { defaultValue: 'Tu plataforma de movilidad en La Habana' })}
        </Text>

        {/* Phone input */}
        <Input
          label={t('auth.phone_label')}
          placeholder="+53 5XXXXXXX"
          keyboardType="phone-pad"
          value={phone}
          onChangeText={setPhone}
          leftIcon={<Ionicons name="call-outline" size={20} color={colors.neutral[400]} />}
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
          disabled={phone.length < 8 || loading}
          fullWidth
          size="lg"
        />

        {/* Divider */}
        <View className="flex-row items-center my-8">
          <View className="flex-1 h-px bg-neutral-200" />
          <Text variant="caption" color="tertiary" className="mx-4">
            {t('auth.or_continue_with', { defaultValue: 'o continúa con' })}
          </Text>
          <View className="flex-1 h-px bg-neutral-200" />
        </View>

        {/* Social login */}
        <View className="flex-row gap-3">
          <Pressable
            className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-xl border border-neutral-200 bg-neutral-50 active:bg-neutral-100"
            onPress={() => authService.signInWithGoogle()}
          >
            <Ionicons name="logo-google" size={20} color={colors.neutral[700]} />
            <Text variant="body" className="font-medium">Google</Text>
          </Pressable>
          <Pressable
            className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-xl border border-neutral-200 bg-neutral-50 active:bg-neutral-100"
            onPress={() => authService.signInWithApple()}
          >
            <Ionicons name="logo-apple" size={20} color={colors.neutral[700]} />
            <Text variant="body" className="font-medium">Apple</Text>
          </Pressable>
        </View>

        {/* Legal text */}
        <Text variant="caption" color="tertiary" className="text-center mt-8 pb-8">
          {t('auth.terms_notice', { defaultValue: 'Al continuar, aceptas nuestros Términos de Servicio y Política de Privacidad' })}
        </Text>
      </View>
    </Screen>
  );
}
