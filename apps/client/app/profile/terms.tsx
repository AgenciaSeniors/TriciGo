// ============================================================
// Client · Terms & Conditions screen
//
// BUG-090 fix: previously this screen loaded https://tricigo.com/terms
// inside a WebView, completely bypassing the cms_content table that
// admins edit via /content. Every admin edit was invisible to mobile
// users. Now we fetch the content via cmsService.getContent('terms')
// and render it natively, with the WebView kept only as a last-resort
// fallback so users are never left with a blank screen.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { View, ActivityIndicator, ScrollView, Pressable, Platform } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { Screen } from '@tricigo/ui/Screen';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { cmsService } from '@tricigo/api/services/cms';
import { useTokens } from '@/hooks/useTokens';

const FALLBACK_URL = 'https://tricigo.com/terms';

export default function TermsScreen() {
  const { t, i18n } = useTranslation('common');
  const tokens = useTokens();
  const [loading, setLoading] = useState(true);
  const [cmsTitle, setCmsTitle] = useState<string | null>(null);
  const [cmsBody, setCmsBody] = useState<string | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [webviewError, setWebviewError] = useState(false);

  const loadCms = useCallback(async () => {
    setLoading(true);
    setFetchFailed(false);
    try {
      const content = await cmsService.getContent('terms');
      if (content) {
        const isEn = (i18n.language ?? 'es').startsWith('en');
        setCmsTitle((isEn ? content.title_en : content.title_es) || content.title_es || content.title_en || null);
        setCmsBody((isEn ? content.body_en : content.body_es) || content.body_es || content.body_en || null);
      } else {
        setFetchFailed(true);
      }
    } catch {
      setFetchFailed(true);
    } finally {
      setLoading(false);
    }
  }, [i18n.language]);

  useEffect(() => { void loadCms(); }, [loadCms]);

  const headerTitle = cmsTitle ?? t('profile.terms', { defaultValue: 'Términos y condiciones' });

  const body = (() => {
    if (loading) {
      return (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colors.brand.orange} />
        </View>
      );
    }
    if (cmsBody) {
      return (
        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
        >
          {cmsBody.split(/\n\s*\n/).map((paragraph, idx) => (
            <Text
              key={idx}
              variant="body"
              style={{ color: tokens.ink.primary, lineHeight: 22, marginBottom: 16 }}
            >
              {paragraph.trim()}
            </Text>
          ))}
        </ScrollView>
      );
    }
    if (fetchFailed && Platform.OS === 'web') {
      return <iframe src={FALLBACK_URL} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} />;
    }
    if (fetchFailed && !webviewError) {
      return (
        <WebView
          source={{ uri: FALLBACK_URL }}
          style={{ flex: 1 }}
          onError={() => setWebviewError(true)}
          onHttpError={() => setWebviewError(true)}
        />
      );
    }
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Ionicons name="cloud-offline-outline" size={48} color={colors.neutral[500]} />
        <Text variant="body" color="tertiary" className="mt-4 mb-4 text-center">
          {t('common.load_error', { defaultValue: 'No se pudo cargar el contenido. Verifica tu conexión.' })}
        </Text>
        <Pressable
          onPress={() => void loadCms()}
          className="px-6 py-3 rounded-xl"
          style={{ backgroundColor: colors.brand.orange }}
        >
          <Text variant="body" color="primary" className="font-semibold">
            {t('common.retry', { defaultValue: 'Reintentar' })}
          </Text>
        </Pressable>
      </View>
    );
  })();

  if (Platform.OS === 'web') {
    return (
      <Screen bg="cuban" padded>
        <View className="pt-4 flex-1">
          <ScreenHeader title={headerTitle} onBack={() => router.back()} />
          {body}
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="cuban" padded={false}>
      <View className="pt-4 px-4">
        <ScreenHeader title={headerTitle} onBack={() => router.back()} />
      </View>
      {body}
    </Screen>
  );
}
