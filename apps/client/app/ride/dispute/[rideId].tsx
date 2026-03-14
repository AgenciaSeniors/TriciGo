import React, { useState } from 'react';
import { View, TextInput, Pressable, Alert, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { disputeService } from '@tricigo/api';
import { useFeatureFlag } from '@tricigo/api/hooks/useFeatureFlag';
import { useAuth } from '@/lib/useAuth';
import { colors } from '@tricigo/theme';
import type { DisputeReason } from '@tricigo/types';

const REASONS: DisputeReason[] = [
  'wrong_fare',
  'wrong_route',
  'driver_behavior',
  'vehicle_condition',
  'safety_issue',
  'unauthorized_charge',
  'service_not_rendered',
  'excessive_wait',
  'lost_item',
  'other',
];

export default function DisputeFormScreen() {
  const { rideId } = useLocalSearchParams<{ rideId: string }>();
  const { t } = useTranslation('rider');
  const { userId } = useAuth();
  const disputesEnabled = useFeatureFlag('formal_disputes_enabled');

  const [reason, setReason] = useState<DisputeReason | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  if (!disputesEnabled) {
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
    if (!reason || !description.trim() || !rideId || !userId) return;

    setSubmitting(true);
    try {
      await disputeService.createDispute({
        ride_id: rideId,
        opened_by: userId,
        reason,
        description: description.trim(),
        evidence_urls: [],
      });
      setSubmitted(true);
    } catch (err: any) {
      Alert.alert(t('common.error'), err?.message ?? 'Error');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <Screen bg="white" padded>
        <View className="pt-4 flex-1 items-center justify-center px-6">
          <View className="w-16 h-16 rounded-full bg-green-100 items-center justify-center mb-4">
            <Text variant="h2">✓</Text>
          </View>
          <Text variant="h3" className="text-center mb-2">{t('dispute.submitted')}</Text>
          <Text variant="body" color="secondary" className="text-center mb-8">
            {t('dispute.submitted_description')}
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
          title={t('dispute.title')}
          onBack={() => router.back()}
        />

        {/* Reason picker */}
        <Text variant="label" className="mb-2 mt-4">{t('dispute.reason_label')}</Text>
        <Card variant="outlined" padding="sm" className="mb-4">
          {REASONS.map((r) => (
            <Pressable
              key={r}
              onPress={() => setReason(r)}
              className={`px-4 py-3 flex-row items-center border-b border-neutral-100 ${
                reason === r ? 'bg-primary-500/10' : ''
              }`}
            >
              <View
                className={`w-5 h-5 rounded-full border-2 mr-3 items-center justify-center ${
                  reason === r ? 'border-primary-500 bg-primary-500' : 'border-neutral-300'
                }`}
              >
                {reason === r && <View className="w-2 h-2 rounded-full bg-white" />}
              </View>
              <Text variant="body" className={reason === r ? 'font-semibold' : ''}>
                {t(`dispute.reason_${r}`)}
              </Text>
            </Pressable>
          ))}
        </Card>

        {/* Description */}
        <Text variant="label" className="mb-2">{t('dispute.description_label')}</Text>
        <TextInput
          className="border border-neutral-200 rounded-xl px-4 py-3 text-base min-h-[120px] mb-6"
          placeholder={t('dispute.description_placeholder')}
          placeholderTextColor="#999"
          value={description}
          onChangeText={setDescription}
          multiline
          textAlignVertical="top"
        />

        {/* Submit */}
        <Button
          title={submitting ? t('dispute.submitting') : t('dispute.submit')}
          variant="primary"
          size="lg"
          fullWidth
          onPress={handleSubmit}
          disabled={!reason || !description.trim() || submitting}
        />
      </View>
    </Screen>
  );
}
