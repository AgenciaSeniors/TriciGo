import React from 'react';
import { View, Pressable, Linking, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';

const APP_VERSION = '1.0.0';

export default function AboutScreen() {
  const { t } = useTranslation('common');

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#171717" />
          </Pressable>
          <Text variant="h3">{t('profile.about_title')}</Text>
        </View>

        <View className="items-center mb-8">
          <Image
            source={require('../../assets/icon.png')}
            style={{ width: 80, height: 80, borderRadius: 16 }}
            className="mb-3"
          />
          <Text variant="h4">{t('app_name')}</Text>
          <Text variant="bodySmall" color="secondary">
            {t('profile.version', { version: APP_VERSION })}
          </Text>
        </View>

        <Card variant="outlined" padding="md" className="mb-4">
          <Text variant="bodySmall" color="secondary" className="text-center">
            TriciGo es la plataforma de transporte en bicitaxi para Cuba. Conectamos pasajeros con conductores de forma rápida y segura.
          </Text>
        </Card>

        <Pressable
          className="flex-row items-center py-4 border-b border-neutral-100"
          onPress={() => Linking.openURL('https://tricigo.app/terms')}
        >
          <Ionicons name="document-text-outline" size={22} color="#525252" />
          <Text variant="body" className="ml-3 flex-1">Términos de servicio</Text>
          <Ionicons name="open-outline" size={18} color="#A3A3A3" />
        </Pressable>

        <Pressable
          className="flex-row items-center py-4 border-b border-neutral-100"
          onPress={() => Linking.openURL('https://tricigo.app/privacy')}
        >
          <Ionicons name="shield-outline" size={22} color="#525252" />
          <Text variant="body" className="ml-3 flex-1">Política de privacidad</Text>
          <Ionicons name="open-outline" size={18} color="#A3A3A3" />
        </Pressable>
      </View>
    </Screen>
  );
}
