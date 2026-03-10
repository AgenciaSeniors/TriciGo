import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';

const FAQ_KEYS = ['faq_q1', 'faq_q2', 'faq_q3'] as const;

export default function HelpScreen() {
  const { t } = useTranslation('common');
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#171717" />
          </Pressable>
          <Text variant="h3">{t('profile.help_title')}</Text>
        </View>

        {FAQ_KEYS.map((key, idx) => {
          const answerKey = key.replace('_q', '_a') as `faq_a${1 | 2 | 3}`;
          const isExpanded = expandedIdx === idx;
          return (
            <Card key={key} variant="outlined" padding="md" className="mb-3">
              <Pressable
                onPress={() => setExpandedIdx(isExpanded ? null : idx)}
                className="flex-row items-center justify-between"
              >
                <Text variant="body" className="flex-1 mr-2">
                  {t(`profile.${key}`)}
                </Text>
                <Ionicons
                  name={isExpanded ? 'chevron-up' : 'chevron-down'}
                  size={20}
                  color="#A3A3A3"
                />
              </Pressable>
              {isExpanded && (
                <Text variant="bodySmall" color="secondary" className="mt-2">
                  {t(`profile.${answerKey}`)}
                </Text>
              )}
            </Card>
          );
        })}

        <Card variant="outlined" padding="md" className="mt-4">
          <Text variant="body" className="font-semibold mb-2">{t('profile.faq_q3')}</Text>
          <View className="flex-row items-center mb-1">
            <Ionicons name="mail-outline" size={18} color="#525252" />
            <Text variant="bodySmall" color="secondary" className="ml-2">soporte@tricigo.app</Text>
          </View>
          <View className="flex-row items-center">
            <Ionicons name="call-outline" size={18} color="#525252" />
            <Text variant="bodySmall" color="secondary" className="ml-2">+53 5XXXXXXX</Text>
          </View>
        </Card>
      </View>
    </Screen>
  );
}
