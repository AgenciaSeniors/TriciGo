import React, { useState } from 'react';
import { View, TextInput, Pressable, Alert, Image, ScrollView } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { disputeService, getSupabaseClient } from '@tricigo/api';
import { useFeatureFlag } from '@tricigo/api/hooks/useFeatureFlag';
import { useAuth } from '@/lib/useAuth';
import { colors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';
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

const MAX_EVIDENCE_PHOTOS = 4;

export default function DisputeFormScreen() {
  const { rideId } = useLocalSearchParams<{ rideId: string }>();
  const { t } = useTranslation('rider');
  const { userId } = useAuth();
  const disputesEnabled = useFeatureFlag('formal_disputes_enabled');

  const [reason, setReason] = useState<DisputeReason | null>(null);
  const [description, setDescription] = useState('');
  const [evidenceUris, setEvidenceUris] = useState<string[]>([]);
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

  const pickImage = async () => {
    if (evidenceUris.length >= MAX_EVIDENCE_PHOTOS) return;

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        t('dispute.permission_title', { defaultValue: 'Permiso requerido' }),
        t('dispute.permission_gallery', { defaultValue: 'Necesitamos acceso a tu galería para adjuntar evidencia.' }),
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: MAX_EVIDENCE_PHOTOS - evidenceUris.length,
      quality: 0.7,
    });

    if (!result.canceled && result.assets.length > 0) {
      const newUris = result.assets.map((a) => a.uri);
      setEvidenceUris((prev) => [...prev, ...newUris].slice(0, MAX_EVIDENCE_PHOTOS));
    }
  };

  const removeEvidence = (index: number) => {
    setEvidenceUris((prev) => prev.filter((_, i) => i !== index));
  };

  const uploadEvidence = async (): Promise<string[]> => {
    if (evidenceUris.length === 0) return [];

    const supabase = getSupabaseClient();
    const urls: string[] = [];

    for (let i = 0; i < evidenceUris.length; i++) {
      const uri = evidenceUris[i]!;
      const response = await fetch(uri);
      const blob = await response.blob();
      const ext = uri.split('.').pop() || 'jpg';
      const storagePath = `disputes/${rideId}/${userId}/${Date.now()}_${i}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('dispute-evidence')
        .upload(storagePath, blob, { contentType: `image/${ext}` });
      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('dispute-evidence')
        .getPublicUrl(storagePath);
      urls.push(urlData.publicUrl);
    }

    return urls;
  };

  const handleSubmit = async () => {
    if (!reason || !description.trim() || !rideId || !userId) return;

    setSubmitting(true);
    try {
      const evidenceUrls = await uploadEvidence();

      await disputeService.createDispute({
        ride_id: rideId,
        opened_by: userId,
        reason,
        description: description.trim(),
        evidence_urls: evidenceUrls,
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
          className="border border-neutral-200 rounded-xl px-4 py-3 text-base min-h-[120px] mb-4"
          placeholder={t('dispute.description_placeholder')}
          placeholderTextColor="#999"
          value={description}
          onChangeText={setDescription}
          multiline
          textAlignVertical="top"
        />

        {/* Evidence photos */}
        <Text variant="label" className="mb-2">
          {t('dispute.evidence_label', { defaultValue: 'Evidencia (opcional)' })}
        </Text>
        <Text variant="caption" color="secondary" className="mb-3">
          {t('dispute.evidence_hint', { defaultValue: 'Adjunta capturas o fotos como evidencia (máx. {{max}})', max: MAX_EVIDENCE_PHOTOS })}
        </Text>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-6">
          <View className="flex-row gap-2">
            {evidenceUris.map((uri, index) => (
              <View key={uri} className="relative">
                <Image
                  source={{ uri }}
                  className="w-20 h-20 rounded-lg"
                  resizeMode="cover"
                  accessibilityLabel={t('dispute.evidence_photo', { defaultValue: 'Foto de evidencia {{n}}', n: index + 1 })}
                />
                <Pressable
                  onPress={() => removeEvidence(index)}
                  className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-500 items-center justify-center"
                  accessibilityRole="button"
                  accessibilityLabel={t('common.delete', { defaultValue: 'Eliminar' })}
                >
                  <Ionicons name="close" size={14} color="#fff" />
                </Pressable>
              </View>
            ))}

            {evidenceUris.length < MAX_EVIDENCE_PHOTOS && (
              <Pressable
                onPress={pickImage}
                className="w-20 h-20 rounded-lg border-2 border-dashed border-neutral-300 items-center justify-center bg-neutral-50"
                accessibilityRole="button"
                accessibilityLabel={t('dispute.add_photo', { defaultValue: 'Agregar foto' })}
              >
                <Ionicons name="camera-outline" size={24} color={colors.neutral[400]} />
                <Text variant="caption" color="secondary" className="mt-1 text-[10px]">
                  {t('dispute.add_photo', { defaultValue: 'Agregar' })}
                </Text>
              </Pressable>
            )}
          </View>
        </ScrollView>

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
