import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';

const FAQ_KEYS = ['faq_q1', 'faq_q2', 'faq_q3'] as const;

export default function DriverHelpScreen() {
  const { t } = useTranslation('common');
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#FAFAFA" />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.help_title')}</Text>
        </View>

        {FAQ_KEYS.map((key, idx) => {
          const answerKey = key.replace('_q', '_a') as `faq_a${1 | 2 | 3}`;
          const isExpanded = expandedIdx === idx;
          return (
            <Card key={key} variant="filled" padding="md" className="mb-3 bg-neutral-800">
              <Pressable
                onPress={() => setExpandedIdx(isExpanded ? null : idx)}
                className="flex-row items-center justify-between"
              >
                <Text variant="body" color="inverse" className="flex-1 mr-2">
                  {t(`profile.${key}`)}
                </Text>
                <Ionicons
                  name={isExpanded ? 'chevron-up' : 'chevron-down'}
                  size={20}
                  color="#A3A3A3"
                />
              </Pressable>
              {isExpanded && (
                <Text variant="bodySmall" color="inverse" className="mt-2 opacity-60">
                  {t(`profile.${answerKey}`)}
                </Text>
              )}
            </Card>
          );
        })}

        <Card variant="filled" padding="md" className="mt-4 bg-neutral-800">
          <Text variant="body" color="inverse" className="font-semibold mb-2">{t('profile.faq_q3')}</Text>
          <View className="flex-row items-center mb-1">
            <Ionicons name="mail-outline" size={18} color="#A3A3A3" />
            <Text variant="bodySmall" color="inverse" className="ml-2 opacity-60">soporte@tricigo.app</Text>
          </View>
          <View className="flex-row items-center">
            <Ionicons name="call-outline" size={18} color="#A3A3A3" />
            <Text variant="bodySmall" color="inverse" className="ml-2 opacity-60">+53 5XXXXXXX</Text>
          </View>
        </Card>
      </View>
    </Screen>
  );
}
