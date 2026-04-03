import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { WebView } from 'react-native-webview';
import { Platform } from 'react-native';

const TERMS_URL = 'https://tricigo.com/terms';

export default function TermsScreen() {
  const { t } = useTranslation('common');

  if (Platform.OS === 'web') {
    return (
      <Screen bg="white" padded>
        <View className="pt-4 flex-1">
          <ScreenHeader title={t('profile.terms', { defaultValue: 'Términos y condiciones' })} onBack={() => router.back()} />
          <iframe src={TERMS_URL} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="white" padded={false}>
      <View className="pt-4 px-4">
        <ScreenHeader title={t('profile.terms', { defaultValue: 'Términos y condiciones' })} onBack={() => router.back()} />
      </View>
      <WebView source={{ uri: TERMS_URL }} style={{ flex: 1 }} />
    </Screen>
  );
}
