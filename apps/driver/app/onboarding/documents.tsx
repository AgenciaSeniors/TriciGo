import React, { useEffect } from 'react';
import { View, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useOnboardingStore } from '@/stores/onboarding.store';
import type { DocumentType } from '@tricigo/types';

function useSteps() {
  const { t } = useTranslation('driver');
  return [
    { key: 'personal', label: t('onboarding.step_personal', { defaultValue: 'Personal' }) },
    { key: 'vehicle', label: t('onboarding.step_vehicle', { defaultValue: 'Vehículo' }) },
    { key: 'documents', label: t('onboarding.step_docs', { defaultValue: 'Docs' }) },
    { key: 'review', label: t('onboarding.step_review', { defaultValue: 'Revisión' }) },
  ];
}

const DOC_LABELS: Record<DocumentType, string> = {
  national_id: 'onboarding.national_id',
  drivers_license: 'onboarding.drivers_license',
  vehicle_registration: 'onboarding.vehicle_registration',
  selfie: 'onboarding.selfie',
  vehicle_photo: 'onboarding.vehicle_photo',
};

export default function DocumentsScreen() {
  const { t } = useTranslation('driver');
  const STEPS = useSteps();
  const user = useAuthStore((s) => s.user);
  const {
    documents,
    driverProfileId,
    setDocumentUri,
    setDocumentUploaded,
    setDocumentUploading,
    setDocumentError,
    setDriverProfileId,
  } = useOnboardingStore();

  // Create driver profile eagerly if not yet created
  useEffect(() => {
    if (driverProfileId || !user) return;

    (async () => {
      try {
        const profile = await driverService.createProfile(user.id);
        setDriverProfileId(profile.id);
      } catch {
        // Profile may already exist
        try {
          const existing = await driverService.getProfile(user.id);
          if (existing) setDriverProfileId(existing.id);
        } catch {
          // Will be handled when user tries to upload
        }
      }
    })();
  }, [driverProfileId, user, setDriverProfileId]);

  const pickAndUpload = async (docType: DocumentType) => {
    if (!driverProfileId) {
      Alert.alert('Error', t('errors.generic'));
      return;
    }

    const isCamera = docType === 'selfie';

    if (isCamera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(t('onboarding.permission_required', { defaultValue: 'Permiso requerido' }), t('onboarding.camera_access_needed', { defaultValue: 'Necesitamos acceso a la cámara.' }));
        return;
      }
    } else {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(t('onboarding.permission_required', { defaultValue: 'Permiso requerido' }), t('onboarding.gallery_access_needed', { defaultValue: 'Necesitamos acceso a la galería.' }));
        return;
      }
    }

    const result = isCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: true })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 0.7,
          allowsEditing: true,
        });

    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    const fileName = asset.fileName ?? `${docType}_${Date.now()}.jpg`;
    setDocumentUri(docType, asset.uri, fileName);

    // Upload immediately
    setDocumentUploading(docType, true);
    try {
      await driverService.uploadDocument(driverProfileId, docType, asset.uri, fileName);
      setDocumentUploaded(docType);
    } catch {
      setDocumentError(docType, t('onboarding.error_upload_failed'));
    }
  };

  const allUploaded = documents.every((d) => d.uploaded);
  const uploadedCount = documents.filter((d) => d.uploaded).length;

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <StatusStepper steps={STEPS} currentStep="documents" className="mb-6" />

        <Text variant="h3" className="mb-1">
          {t('onboarding.step_documents')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          {t('onboarding.step_n_of_total', { step: 3, total: 4 })} — {uploadedCount}/5
        </Text>

        {documents.map((doc) => (
          <Pressable key={doc.document_type} onPress={() => pickAndUpload(doc.document_type)}>
            <Card variant="outlined" padding="md" className="mb-3 flex-row items-center">
              {doc.uploading ? (
                <ActivityIndicator size="small" color={colors.brand.orange} />
              ) : (
                <Ionicons
                  name={doc.uploaded ? 'checkmark-circle' : 'cloud-upload-outline'}
                  size={24}
                  color={doc.uploaded ? '#10B981' : '#A3A3A3'}
                />
              )}
              <View className="flex-1 ml-3">
                <Text variant="body">{t(DOC_LABELS[doc.document_type])}</Text>
                {doc.error ? (
                  <Text variant="caption" color="error">{doc.error}</Text>
                ) : (
                  <Text variant="caption" color={doc.uploaded ? 'accent' : 'tertiary'}>
                    {doc.uploaded ? t('onboarding.uploaded', { defaultValue: 'Subido' }) : doc.document_type === 'selfie' ? t('onboarding.take_photo') : t('onboarding.pick_from_gallery')}
                  </Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={20} color="#A3A3A3" />
            </Card>
          </Pressable>
        ))}

        <Button
          title={t('common:next')}
          size="lg"
          fullWidth
          className="mt-4"
          onPress={() => router.push('/onboarding/review')}
          disabled={!allUploaded}
        />
      </View>
    </Screen>
  );
}
