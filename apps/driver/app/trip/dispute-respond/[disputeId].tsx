import React, { useEffect, useState } from 'react';
import { View, TextInput, Pressable, Alert, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { disputeService } from '@tricigo/api';
import { useAuth } from '@/lib/useAuth';
import { colors } from '@tricigo/theme';
import type { RideDispute } from '@tricigo/types';

const REASON_LABELS: Record<string, string> = {
  wrong_fare: 'Tarifa incorrecta',
  wrong_route: 'Ruta incorrecta',
  driver_behavior: 'Comportamiento del conductor',
  vehicle_condition: 'Condición del vehículo',
  safety_issue: 'Problema de seguridad',
  unauthorized_charge: 'Cobro no autorizado',
  service_not_rendered: 'Servicio no prestado',
  excessive_wait: 'Espera excesiva',
  lost_item: 'Objeto perdido',
  other: 'Otro',
};

export default function DisputeRespondScreen() {
  const { disputeId } = useLocalSearchParams<{ disputeId: string }>();
  const { t } = useTranslation('driver');
  const { userId } = useAuth();

  const [dispute, setDispute] = useState<RideDispute | null>(null);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // We don't have a getDisputeById, but the dispute data is passed from the previous screen
    // For now, we'll work with just the disputeId and submit the response
    setLoading(false);
  }, [disputeId]);

  const handleSubmit = async () => {
    if (!message.trim() || !disputeId || !userId) return;

    setSubmitting(true);
    try {
      await disputeService.respondToDispute(disputeId, userId, message.trim(), []);
      setSubmitted(true);
    } catch (err: any) {
      Alert.alert(t('common.error'), err?.message ?? 'Error');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <Screen bg="lightPrimary" statusBarStyle="dark-content" padded>
        <View className="pt-4 flex-1 items-center justify-center px-6">
          <View className="w-16 h-16 rounded-full bg-green-100 items-center justify-center mb-4">
            <Text variant="h2" color="primary">✓</Text>
          </View>
          <Text variant="h3" color="primary" className="text-center mb-2">{t('dispute.responded')}</Text>
          <Text variant="body" color="primary" className="text-center mb-8 opacity-60">
            {t('dispute.responded_description')}
          </Text>
          <Button
            title={t('trip.back_to_home')}
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
    <Screen scroll bg="lightPrimary" statusBarStyle="dark-content" padded>
      <View className="pt-4 pb-8">
        {/* Header */}
        <Pressable onPress={() => router.back()} className="mb-4">
          <Text variant="body" color="accent">← {t('trip.back_to_home', { defaultValue: 'Volver' })}</Text>
        </Pressable>

        <Text variant="h3" color="primary" className="mb-6">{t('dispute.respond')}</Text>

        {/* Info banner */}
        <Card theme="light" variant="filled" padding="md" className="bg-orange-50 mb-6">
          <Text variant="bodySmall" color="primary" className="opacity-80">
            {t('dispute.incoming')}
          </Text>
        </Card>

        {/* Response form */}
        <Text variant="label" color="primary" className="mb-2">{t('dispute.your_response')}</Text>
        <TextInput
          className="border border-[#E2E8F0] rounded-xl px-4 py-3 text-base min-h-[160px] mb-6 text-neutral-900 bg-white"
          placeholder={t('dispute.respond_placeholder')}
          placeholderTextColor="#666"
          value={message}
          onChangeText={setMessage}
          multiline
          textAlignVertical="top"
        />

        {/* Submit */}
        <Button
          title={submitting ? t('dispute.submitting') : t('dispute.submit_response')}
          variant="primary"
          size="lg"
          fullWidth
          onPress={handleSubmit}
          disabled={!message.trim() || submitting}
        />
      </View>
    </Screen>
  );
}
