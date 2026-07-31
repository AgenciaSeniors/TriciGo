// ============================================================
// Driver · Terms & Conditions screen
//
// BUG-090 fix: previously this screen loaded `https://tricigo.com/terms`
// inside a WebView, completely bypassing the `cms_content` table that
// admins edit from /content. Every admin update was invisible to
// mobile users.
//
// Now we fetch the content via cmsService.getContent('terms') and
// render it as plain paragraphs that honor the current i18next
// language. The old WebView is kept ONLY as a fallback if the CMS
// fetch fails (e.g. offline) — that way we never show an empty screen.
// ============================================================

import React, { useEffect, useState } from 'react';
import { View, Pressable, ActivityIndicator, ScrollView, Platform, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { WebView } from 'react-native-webview';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark } from '@tricigo/theme';
import { cmsService } from '@tricigo/api/services/cms';

const FALLBACK_URL = 'https://tricigo.com/terms';

export default function TermsScreen() {
  const { t, i18n } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const [loading, setLoading] = useState(true);
  const [cmsTitle, setCmsTitle] = useState<string | null>(null);
  const [cmsBody, setCmsBody] = useState<string | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [webviewError, setWebviewError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const content = await cmsService.getContent('terms');
        if (cancelled) return;
        if (content) {
          const isEn = (i18n.language ?? 'es').startsWith('en');
          const title = isEn ? content.title_en : content.title_es;
          const body = isEn ? content.body_en : content.body_es;
          // Locale-aware fallback: if the requested locale is empty,
          // fall back to whichever body has content.
          setCmsTitle(title || content.title_es || content.title_en || null);
          setCmsBody(body || content.body_es || content.body_en || null);
        } else {
          setFetchFailed(true);
        }
      } catch {
        if (!cancelled) setFetchFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [i18n.language]);

  return (
    <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded={false}>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4 px-4">
        <ProfileScreenHeader
          title={cmsTitle ?? t('profile.terms', { defaultValue: 'Términos y condiciones' })}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back', { defaultValue: 'Atrás' })}
          className="mb-4"
        />
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={midnightEmber.accent[500]} />
        </View>
      ) : cmsBody ? (
        // CMS body available → render natively (no WebView at all).
        // Paragraphs are split on blank lines to preserve authoring intent.
        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
        >
          {cmsBody.split(/\n\s*\n/).map((paragraph, idx) => (
            <Text
              key={idx}
              variant="body"
              style={{ color: midnightEmber.screen.text.secondary, lineHeight: 22, marginBottom: 16 }}
            >
              {paragraph.trim()}
            </Text>
          ))}
        </ScrollView>
      ) : fetchFailed && Platform.OS === 'web' ? (
        <iframe src={FALLBACK_URL} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} />
      ) : fetchFailed && !webviewError ? (
        // Last-resort fallback: if CMS lookup failed, still show the
        // public web page so the user is never left with an empty view.
        <WebView
          source={{ uri: FALLBACK_URL }}
          style={{ flex: 1 }}
          startInLoadingState
          renderLoading={() => (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: midnightEmber.screen.bg.canvas }}>
              <ActivityIndicator size="large" color={midnightEmber.accent[500]} />
            </View>
          )}
          onError={() => setWebviewError(true)}
          onHttpError={() => setWebviewError(true)}
        />
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          <Ionicons name="cloud-offline-outline" size={48} color={midnightEmber.screen.text.tertiary} />
          <Text variant="body" color="tertiary" className="mt-4 mb-4 text-center">
            {t('common.load_error', { defaultValue: 'No se pudo cargar el contenido. Verifica tu conexión.' })}
          </Text>
          <Pressable
            onPress={() => {
              setWebviewError(false);
              setFetchFailed(false);
              setLoading(true);
              // Reload by bumping a state change (simplest approach).
              cmsService.getContent('terms').then((c) => {
                const isEn = (i18n.language ?? 'es').startsWith('en');
                setCmsTitle(c ? (isEn ? c.title_en : c.title_es) || null : null);
                setCmsBody(c ? (isEn ? c.body_en : c.body_es) || null : null);
                if (!c) setFetchFailed(true);
              }).catch(() => setFetchFailed(true)).finally(() => setLoading(false));
            }}
            className="px-6 py-3 rounded-xl"
            style={{ backgroundColor: midnightEmber.accent[500] }}
          >
            <Text variant="body" color="primary" className="font-semibold">
              {t('common.retry', { defaultValue: 'Reintentar' })}
            </Text>
          </Pressable>
        </View>
      )}
      </View>
    </Screen>
  );
}
