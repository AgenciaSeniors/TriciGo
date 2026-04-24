// ============================================================
// Driver · Privacy Policy screen
//
// BUG-090 fix (same pattern as terms.tsx): previously loaded
// https://tricigo.com/privacy inside a WebView, skipping the
// cms_content table that admins edit. Now we fetch the 'privacy'
// row via cmsService.getContent() and render it natively, with
// the WebView retained only as a last-resort fallback.
// ============================================================

import React, { useEffect, useState } from 'react';
import { View, Pressable, ActivityIndicator, ScrollView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { WebView } from 'react-native-webview';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { cmsService } from '@tricigo/api/services/cms';

const FALLBACK_URL = 'https://tricigo.com/privacy';

export default function PrivacyScreen() {
  const { t, i18n } = useTranslation('common');
  const [loading, setLoading] = useState(true);
  const [cmsTitle, setCmsTitle] = useState<string | null>(null);
  const [cmsBody, setCmsBody] = useState<string | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [webviewError, setWebviewError] = useState(false);

  const loadCms = React.useCallback(async () => {
    setLoading(true);
    setFetchFailed(false);
    try {
      const content = await cmsService.getContent('privacy');
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await loadCms();
    })();
    return () => { cancelled = true; };
  }, [loadCms]);

  return (
    <Screen bg="lightPrimary" statusBarStyle="dark-content" padded={false}>
      <View className="pt-4 px-4">
        <View className="flex-row items-center mb-4">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', { defaultValue: 'Atrás' })}
            className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
            style={{ backgroundColor: colors.neutral[100] }}
          >
            <Ionicons name="arrow-back" size={20} color={colors.neutral[800]} />
          </Pressable>
          <Text variant="h3" color="primary">
            {cmsTitle ?? t('profile.privacy', { defaultValue: 'Política de privacidad' })}
          </Text>
        </View>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colors.brand.orange} />
        </View>
      ) : cmsBody ? (
        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
        >
          {cmsBody.split(/\n\s*\n/).map((paragraph, idx) => (
            <Text
              key={idx}
              variant="body"
              style={{ color: '#334155', lineHeight: 22, marginBottom: 16 }}
            >
              {paragraph.trim()}
            </Text>
          ))}
        </ScrollView>
      ) : fetchFailed && Platform.OS === 'web' ? (
        <iframe src={FALLBACK_URL} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} />
      ) : fetchFailed && !webviewError ? (
        <WebView
          source={{ uri: FALLBACK_URL }}
          style={{ flex: 1 }}
          startInLoadingState
          renderLoading={() => (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F8FAFC' }}>
              <ActivityIndicator size="large" color={colors.brand.orange} />
            </View>
          )}
          onError={() => setWebviewError(true)}
          onHttpError={() => setWebviewError(true)}
        />
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          <Ionicons name="cloud-offline-outline" size={48} color={colors.neutral[500]} />
          <Text variant="body" color="tertiary" className="mt-4 mb-4 text-center">
            {t('common.load_error', { defaultValue: 'No se pudo cargar el contenido. Verificá tu conexión.' })}
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
      )}
    </Screen>
  );
}
