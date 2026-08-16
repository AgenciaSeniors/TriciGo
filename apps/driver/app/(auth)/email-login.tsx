// ============================================================
// Entrar con el correo — la segunda puerta cuando el SMS no llega.
//
// El 2026-08-15 la ruta de D7 hacia ETECSA dejó de entregar durante 15 h y los
// conductores no tuvieron NINGUNA forma de entrar: su cuenta cuelga del teléfono
// y el botón de Google les crearía una cuenta nueva en vez de recuperar la suya.
//
// Requiere haber confirmado antes el correo desde Perfil → Editar perfil (ahí se
// promueve a identidad real vía addBackupEmail). Si no lo hizo, esta pantalla
// responde igual — la Edge Function no revela si la cuenta existe.
// ============================================================
import React, { useState } from 'react';
import { View, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Input } from '@tricigo/ui/Input';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { isValidEmail } from '@tricigo/utils';
import { colors, midnightEmber } from '@tricigo/theme';

export default function EmailLoginScreen() {
  const { t } = useTranslation('common');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    setError('');
    const value = email.trim();
    if (!isValidEmail(value)) {
      setError(t('auth.email_invalid', { defaultValue: 'Escribí un correo válido' }));
      return;
    }

    setLoading(true);
    try {
      await authService.sendEmailLoginLink(value, 'driver');
      // Se muestra el mismo acuse exista o no la cuenta: la EF no distingue, y
      // que la pantalla lo hiciera reintroduciría el oráculo de enumeración.
      setSent(true);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      setError(
        code === 'rate_limited'
          ? t('auth.email_link_rate_limited', {
              defaultValue: 'Pediste varios enlaces seguidos. Esperá una hora e intentá de nuevo.',
            })
          : t('errors.generic'),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <View className="pt-4 pb-6">
            <Button
              title={t('back')}
              variant="ghost"
              onPress={() => router.back()}
              accessibilityLabel={t('back')}
            />
          </View>

          {sent ? (
            <View className="flex-1 items-center justify-center px-2">
              <Ionicons name="mail-open-outline" size={56} color={colors.brand.orange} />
              <Text variant="h3" color="inverse" className="mt-4 mb-2 text-center">
                {t('auth.email_link_sent_title', { defaultValue: 'Revisá tu correo' })}
              </Text>
              <Text
                variant="bodySmall"
                className="text-center"
                style={{ color: midnightEmber.map.text.secondary }}
              >
                {t('auth.email_link_sent_body', {
                  email: email.trim(),
                  defaultValue:
                    'Si {{email}} está registrado, te llegó un enlace para entrar. Vence en 1 hora y sirve una sola vez.',
                })}
              </Text>
            </View>
          ) : (
            <View className="flex-1">
              <Text variant="h3" color="inverse" className="mb-1">
                {t('auth.email_login_title', { defaultValue: 'Entrar con tu correo' })}
              </Text>
              <Text
                variant="bodySmall"
                className="mb-6"
                style={{ color: midnightEmber.map.text.secondary }}
              >
                {t('auth.email_login_description', {
                  defaultValue:
                    'Te mandamos un enlace para entrar sin esperar el código por SMS. Funciona con el correo que confirmaste en tu perfil.',
                })}
              </Text>

              <Input
                placeholder="tucorreo@ejemplo.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                value={email}
                onChangeText={setEmail}
                variant="dark"
                autoFocus
                accessibilityLabel={t('auth.email_input_label', { defaultValue: 'Correo electrónico' })}
              />

              {error ? (
                <Text variant="bodySmall" color="error" className="mt-2">
                  {error}
                </Text>
              ) : null}

              <Button
                title={t('auth.send_email_link', { defaultValue: 'Enviarme el enlace' })}
                onPress={handleSend}
                loading={loading}
                disabled={!email.trim() || loading}
                fullWidth
                size="lg"
                className="mt-4"
              />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
