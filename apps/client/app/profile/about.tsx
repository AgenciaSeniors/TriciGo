import React from 'react';
import { View, Image } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { ProfileSection } from '@/components/profile/ProfileSection';
import { ProfileRow } from '@/components/profile/ProfileRow';
import { useTokens } from '@/hooks/useTokens';
import { useTranslation } from '@tricigo/i18n';
import Constants from 'expo-constants';

// Read the version from the build instead of hardcoding it. This was
// pinned at '1.0.0' while app.json had long moved on (1.3.0 at the time
// of writing), so the screen misreported the build to anyone who asked
// support "what version are you on?". The `?? '—'` avoids inventing a
// number if the manifest is somehow unavailable.
const APP_VERSION = Constants.expoConfig?.version ?? '—';

export default function AboutScreen() {
  const { t } = useTranslation('common');
  const tokens = useTokens();

  return (
    <Screen scroll bg="cuban" padded>
      <View className="pt-4">
        <ScreenHeader title={t('profile.about_title')} onBack={() => router.back()} />

        {/* App logo & version */}
        <View className="items-center mb-8 mt-2">
          <View
            style={{
              shadowColor: '#000',
              shadowOpacity: 0.12,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 6 },
              elevation: 8,
              borderRadius: 22,
            }}
            className="mb-4"
          >
            <Image
              source={require('../../assets/icon.png')}
              style={{ width: 88, height: 88, borderRadius: 22 }}
              accessibilityLabel="TriciGo logo"
            />
          </View>
          <Text style={{ color: tokens.ink.primary, fontFamily: 'Montserrat_700Bold', fontSize: 24, letterSpacing: -0.4 }}>
            {t('app_name')}
          </Text>
          <Text style={{ color: tokens.ink.subtle, fontSize: 13, marginTop: 4 }}>
            {t('profile.version', { version: APP_VERSION })}
          </Text>
        </View>

        {/* Description */}
        <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 16, marginBottom: 20 }}>
          <Text style={{ color: tokens.ink.secondary, fontSize: 14, lineHeight: 21, textAlign: 'center' }}>
            {t('profile.about_description')}
          </Text>
        </View>

        {/* Legal links */}
        <ProfileSection title={t('profile.about_legal', { defaultValue: 'Legal' })}>
          <ProfileRow
            icon="document-text-outline"
            tint={tokens.ink.secondary}
            label={t('profile.terms_of_service')}
            onPress={() => router.push('/profile/terms')}
          />
          <ProfileRow
            icon="shield-outline"
            tint="#3B82F6"
            label={t('profile.privacy_policy')}
            onPress={() => router.push('/profile/privacy')}
            isLast
          />
        </ProfileSection>
      </View>
    </Screen>
  );
}
