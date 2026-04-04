import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { WebView } from 'react-native-webview';
import { Platform } from 'react-native';

const TERMS_URL = 'https://tricigo.com/terms';

export default function TermsScreen() {
  const { t } = useTranslation('common');

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded={false}>
      <View className="pt-4 px-4">
        <View className="flex-row items-center mb-4">
          <Pressable
            onPress={() => router.back()}
            className="mr-3 w-10 h-10 rounded-xl bg-[#1e1e1e] items-center justify-center"
          >
            <Ionicons name="arrow-back" size={20} color={colors.neutral[50]} />
          </Pressable>
          <Text variant="h3" color="inverse">
            {t('profile.terms', { defaultValue: 'Términos y condiciones' })}
          </Text>
        </View>
      </View>
      {Platform.OS === 'web' ? (
        <iframe src={TERMS_URL} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} />
      ) : (
        <WebView source={{ uri: TERMS_URL }} style={{ flex: 1 }} />
      )}
    </Screen>
  );
}
