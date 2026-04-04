import React, { useState } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors, driverDarkColors } from '@tricigo/theme';
import { WebView } from 'react-native-webview';
import { Platform } from 'react-native';

const PRIVACY_URL = 'https://tricigo.com/privacy';

export default function PrivacyScreen() {
  const { t } = useTranslation('common');
  const [error, setError] = useState(false);

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded={false}>
      <View className="pt-4 px-4">
        <View className="flex-row items-center mb-4">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', { defaultValue: 'Back' })}
            className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
            style={{ backgroundColor: driverDarkColors.hover }}
          >
            <Ionicons name="arrow-back" size={20} color={colors.neutral[50]} />
          </Pressable>
          <Text variant="h3" color="inverse">
            {t('profile.privacy', { defaultValue: 'Política de privacidad' })}
          </Text>
        </View>
      </View>
      {Platform.OS === 'web' ? (
        <iframe src={PRIVACY_URL} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} />
      ) : error ? (
        <View className="flex-1 items-center justify-center px-6">
          <Ionicons name="cloud-offline-outline" size={48} color={colors.neutral[500]} />
          <Text variant="body" color="tertiary" className="mt-4 mb-4 text-center">
            {t('common.load_error', { defaultValue: 'No se pudo cargar la página. Verifica tu conexión.' })}
          </Text>
          <Pressable
            onPress={() => setError(false)}
            className="px-6 py-3 rounded-xl"
            style={{ backgroundColor: colors.brand.orange }}
          >
            <Text variant="body" color="inverse" className="font-semibold">
              {t('common.retry', { defaultValue: 'Reintentar' })}
            </Text>
          </Pressable>
        </View>
      ) : (
        <WebView
          source={{ uri: PRIVACY_URL }}
          style={{ flex: 1 }}
          startInLoadingState
          renderLoading={() => (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: driverDarkColors.background.primary }}>
              <ActivityIndicator size="large" color={colors.brand.orange} />
            </View>
          )}
          onError={() => setError(true)}
          onHttpError={() => setError(true)}
        />
      )}
    </Screen>
  );
}
