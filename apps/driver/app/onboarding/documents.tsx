import React, { useEffect } from 'react';
import { View, Pressable, ActivityIndicator, Alert, Platform } from 'react-native';
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
        console.log('[Documents] Creating driver profile for user:', user.id);
        const profile = await driverService.createProfile(user.id);
        console.log('[Documents] Profile created:', profile.id);
        setDriverProfileId(profile.id);
      } catch (createErr) {
        console.warn('[Documents] createProfile failed, trying getProfile:', createErr instanceof Error ? createErr.message : createErr);
        // Profile may already exist
        try {
          const existing = await driverService.getProfile(user.id);
          if (existing) {
            console.log('[Documents] Existing profile found:', existing.id);
            setDriverProfileId(existing.id);
          } else {
            console.error('[Documents] No profile found for user');
          }
        } catch (getErr) {
          console.error('[Documents] getProfile also failed:', getErr instanceof Error ? getErr.message : getErr);
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
    const isWeb = Platform.OS === 'web';

    // On native, check permissions first.
    // On web, skip — permissions are always granted AND the await breaks
    // the browser's user activation context, preventing the file dialog from opening.
    if (!isWeb) {
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
    }

    // On web, camera is not available — always use gallery
    const useCamera = isCamera && !isWeb;

    const result = useCamera
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
      console.log('[Documents] Uploading:', docType, 'profileId:', driverProfileId);
      // Add timeout to prevent infinite loading
      const uploadPromise = driverService.uploadDocument(driverProfileId, docType, asset.uri, fileName);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Upload timeout after 30s')), 30000),
      );
      await Promise.race([uploadPromise, timeoutPromise]);
      setDocumentUploaded(docType);
      console.log('[Documents] Upload success:', docType);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Documents] Upload failed:', docType, msg);
      setDocumentError(docType, `${t('onboarding.error_upload_failed')} (${msg})`);
      setDocumentUploading(docType, false);
    }
  };

  const allUploaded = documents.every((d) => d.uploaded);
  const uploadedCount = documents.filter((d) => d.uploaded).length;

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <StatusStepper steps={STEPS} currentStep="documents" className="mb-6" />

        <Text variant="h3" color="inverse" className="mb-1">
          {t('onboarding.step_documents')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          {t('onboarding.step_n_of_total', { step: 3, total: 4 })} — {uploadedCount}/5
        </Text>

        {documents.map((doc) => (
          <Pressable
            key={doc.document_type}
            onPress={() => pickAndUpload(doc.document_type)}
            accessibilityRole="button"
            accessibilityLabel={t(DOC_LABELS[doc.document_type])}
          >
            <Card variant="surface" padding="md" className="mb-3 flex-row items-center">
              {doc.uploading ? (
                <ActivityIndicator size="small" color={colors.brand.orange} />
              ) : (
                <Ionicons
                  name={doc.uploaded ? 'checkmark-circle' : 'cloud-upload-outline'}
                  size={24}
                  color={doc.uploaded ? colors.status.verified : colors.neutral[400]}
                />
              )}
              <View className="flex-1 ml-3">
                <Text variant="body" color="inverse">{t(DOC_LABELS[doc.document_type])}</Text>
                {doc.error ? (
                  <Text variant="caption" color="error">{doc.error}</Text>
                ) : (
                  <Text variant="caption" color={doc.uploaded ? 'accent' : 'secondary'}>
                    {doc.uploaded ? t('onboarding.uploaded', { defaultValue: 'Subido' }) : doc.document_type === 'selfie' ? t('onboarding.take_photo') : t('onboarding.pick_from_gallery')}
                  </Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.neutral[500]} />
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
