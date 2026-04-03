import React, { useState } from 'react';
import { View, TextInput, Pressable, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { lostItemService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useFeatureFlag } from '@tricigo/api/hooks/useFeatureFlag';
import { useAuth } from '@/lib/useAuth';
import { Ionicons } from '@expo/vector-icons';
import { colors, darkColors } from '@tricigo/theme';
import { useThemeStore } from '@/stores/theme.store';
import type { LostItemCategory } from '@tricigo/types';

const CATEGORIES: { key: LostItemCategory; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'phone', icon: 'phone-portrait-outline' },
  { key: 'wallet', icon: 'wallet-outline' },
  { key: 'bag', icon: 'bag-handle-outline' },
  { key: 'clothing', icon: 'shirt-outline' },
  { key: 'electronics', icon: 'laptop-outline' },
  { key: 'documents', icon: 'document-text-outline' },
  { key: 'keys', icon: 'key-outline' },
  { key: 'other', icon: 'help-circle-outline' },
];

export default function LostItemReportScreen() {
  const { rideId, driverId } = useLocalSearchParams<{ rideId: string; driverId: string }>();
  const { t } = useTranslation('rider');
  const { userId } = useAuth();
  const lostFoundEnabled = useFeatureFlag('lost_and_found_enabled');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';

  const [category, setCategory] = useState<LostItemCategory | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  if (!lostFoundEnabled) {
    return (
      <Screen bg="white" padded>
        <View className="pt-4">
          <ScreenHeader title="" onBack={() => router.back()} />
          <Text variant="body" color="tertiary">Feature not available</Text>
        </View>
      </Screen>
    );
  }

  const handleSubmit = async () => {
    if (!category || !description.trim() || !rideId || !userId || !driverId) return;

    setSubmitting(true);
    try {
      await lostItemService.reportLostItem({
        ride_id: rideId,
        reporter_id: userId,
        driver_id: driverId,
        description: description.trim(),
        category,
        photo_urls: [],
      });
      setSubmitted(true);
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown> | null;
      if (typeof errObj?.message === 'string' && (errObj.message.includes('duplicate') || errObj?.code === '23505')) {
        Alert.alert(t('common.error'), t('lost_found.already_reported'));
      } else {
        Alert.alert(t('common.error'), getErrorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <Screen bg="white" padded>
        <View className="pt-4 flex-1 items-center justify-center px-6">
          <View className="w-16 h-16 rounded-full bg-green-100 items-center justify-center mb-4">
            <Ionicons name="checkmark" size={32} color={colors.success.DEFAULT} />
          </View>
          <Text variant="h3" className="text-center mb-2">{t('lost_found.submitted')}</Text>
          <Text variant="body" color="secondary" className="text-center mb-8">
            {t('lost_found.submitted_desc')}
          </Text>
          <Button
            title={t('ride.done')}
            variant="primary"
            size="lg"
            fullWidth
            onPress={() => router.back()}
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4 pb-8">
        <ScreenHeader
          title={t('lost_found.report_item')}
          onBack={() => router.back()}
        />

        {/* Category picker */}
        <Text variant="label" className="mb-2 mt-4">{t('lost_found.category_label')}</Text>
        <View className="flex-row flex-wrap gap-3 mb-6">
          {CATEGORIES.map((c) => (
            <Pressable
              key={c.key}
              onPress={() => setCategory(c.key)}
              className={`items-center justify-center w-[22%] py-3 rounded-xl border-2 ${
                category === c.key
                  ? 'border-primary-500 bg-primary-500/10'
                  : 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900'
              }`}
            >
              <Ionicons
                name={c.icon}
                size={24}
                color={category === c.key ? colors.brand.orange : (isDark ? darkColors.text.secondary : colors.neutral[400])}
              />
              <Text
                variant="caption"
                className={`mt-1 text-center ${category === c.key ? 'font-semibold' : ''}`}
                color={category === c.key ? 'primary' : 'secondary'}
              >
                {t(`lost_found.category_${c.key}`)}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Description */}
        <Text variant="label" className="mb-2">{t('lost_found.description_label')}</Text>
        <TextInput
          className="border border-neutral-200 dark:border-neutral-700 rounded-xl px-4 py-3 text-base min-h-[120px] mb-6"
          placeholder={t('lost_found.description_placeholder')}
          placeholderTextColor={isDark ? darkColors.text.tertiary : '#999'}
          style={isDark ? { color: darkColors.text.primary, backgroundColor: darkColors.background.secondary } : undefined}
          value={description}
          onChangeText={setDescription}
          multiline
          textAlignVertical="top"
        />

        {/* Submit */}
        <Button
          title={submitting ? t('lost_found.submitting') : t('lost_found.submit')}
          variant="primary"
          size="lg"
          fullWidth
          onPress={handleSubmit}
          disabled={!category || !description.trim() || submitting}
        />
      </View>
    </Screen>
  );
}
