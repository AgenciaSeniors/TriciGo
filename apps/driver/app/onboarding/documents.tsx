import React, { useEffect } from 'react';
import { View, Pressable, ActivityIndicator, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useOnboardingStore } from '@/stores/onboarding.store';
import { SwitchAccountFooter } from '@/components/onboarding/SwitchAccountFooter';
import { compressDocument, formatSizeDelta } from '@/lib/compressDocument';
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

// Label keys for every document tile. Which docs actually render (and whether
// they're required) is driven by the onboarding store's INITIAL_DOCUMENTS.
// selfie is captured with the front camera (see pickImage); it's a manual-review
// photo, NOT biometric — the onboarding flow never calls `verify-selfie`.
const DOC_LABELS: Record<DocumentType, string> = {
  national_id: 'onboarding.national_id',
  drivers_license: 'onboarding.drivers_license',
  vehicle_registration: 'onboarding.vehicle_registration',
  selfie: 'onboarding.selfie',
  vehicle_photo: 'onboarding.vehicle_photo',
  operating_license: 'onboarding.operating_license',
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

  /** Document types that accept PDF uploads in addition to images */
  const PDF_ELIGIBLE_TYPES: DocumentType[] = ['national_id', 'drivers_license', 'vehicle_registration', 'operating_license'];

  const uploadFile = async (docType: DocumentType, uri: string, fileName: string, mimeType?: string) => {
    if (!driverProfileId) return;
    setDocumentUri(docType, uri, fileName, mimeType);
    setDocumentUploading(docType, true);
    try {
      console.log('[Documents] Uploading:', docType, 'profileId:', driverProfileId, 'mime:', mimeType);
      const uploadPromise = driverService.uploadDocument(driverProfileId, docType, uri, fileName, mimeType);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Upload timeout after 30s')), 30000),
      );
      await Promise.race([uploadPromise, timeoutPromise]);
      setDocumentUploaded(docType);
      console.log('[Documents] Upload success:', docType);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error('[Documents] Upload failed:', docType, msg);
      setDocumentError(docType, `${t('onboarding.error_upload_failed')} (${msg})`);
      setDocumentUploading(docType, false);
    }
  };

  const pickImage = async (docType: DocumentType) => {
    const isCamera = docType === 'selfie';
    const isWeb = Platform.OS === 'web';

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

    const useCamera = isCamera && !isWeb;
    const result = useCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: true, cameraType: ImagePicker.CameraType.front })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 0.7,
          // Documents (ID, license, registration, vehicle photo) are rectangular.
          // The forced OS square-crop window was far too cramped to frame a whole
          // document, so skip editing and upload the full photo for human review.
          allowsEditing: false,
        });

    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const fileName = asset.fileName ?? `${docType}_${Date.now()}.jpg`;
    const mimeType = asset.mimeType ?? 'image/jpeg';

    // Compress before upload. Cuba's slow connections would otherwise
    // time out the 30s upload budget on a 4–6 MB raw photo. A 1600px
    // JPEG @ 0.7 typically lands at 200–400 KB — good enough for
    // human document review.
    const compressed = await compressDocument(asset.uri, mimeType);
    if (compressed.wasCompressed && compressed.originalBytes > 0) {
      Toast.show({
        type: 'info',
        text1: t('onboarding.document_compressed', { defaultValue: 'Imagen optimizada' }),
        text2: formatSizeDelta(compressed.originalBytes, compressed.compressedBytes),
        visibilityTime: 2000,
      });
    }
    // After compression the output is always JPEG, so the original mimeType
    // doesn't apply — use 'image/jpeg' explicitly if we compressed.
    const uploadMime = compressed.wasCompressed ? 'image/jpeg' : mimeType;
    await uploadFile(docType, compressed.uri, fileName, uploadMime);
  };

  const pickDocument = async (docType: DocumentType) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const fileName = asset.name ?? `${docType}_${Date.now()}.pdf`;
      const mimeType = asset.mimeType ?? 'application/pdf';

      // Compress images; PDFs pass through (compressDocument is a no-op
      // for non-image mime types). Crucial for Cuba's connectivity.
      const compressed = await compressDocument(asset.uri, mimeType);
      if (compressed.wasCompressed && compressed.originalBytes > 0) {
        Toast.show({
          type: 'info',
          text1: t('onboarding.document_compressed', { defaultValue: 'Imagen optimizada' }),
          text2: formatSizeDelta(compressed.originalBytes, compressed.compressedBytes),
          visibilityTime: 2000,
        });
      }
      const uploadMime = compressed.wasCompressed ? 'image/jpeg' : mimeType;
      await uploadFile(docType, compressed.uri, fileName, uploadMime);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error('[Documents] Document pick failed:', docType, msg);
      setDocumentError(docType, msg);
    }
  };

  const handleDocumentPress = (docType: DocumentType) => {
    if (!driverProfileId) {
      Alert.alert('Error', t('errors.generic'));
      return;
    }

    if (PDF_ELIGIBLE_TYPES.includes(docType)) {
      Alert.alert(
        t('onboarding.upload_method', { defaultValue: 'Método de subida' }),
        t('onboarding.choose_upload', { defaultValue: '¿Cómo quieres subir este documento?' }),
        [
          { text: t('onboarding.from_gallery', { defaultValue: 'Foto / Galería' }), onPress: () => pickImage(docType) },
          { text: t('onboarding.upload_pdf', { defaultValue: 'Documento (PDF)' }), onPress: () => pickDocument(docType) },
          { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        ],
      );
    } else {
      pickImage(docType);
    }
  };

  // Optional docs (e.g. drivers_license) don't gate progression: Next enables
  // once every REQUIRED doc is uploaded. The subtitle counts required only so
  // "3/3" reads as complete even when the optional license is skipped.
  const requiredDocs = documents.filter((d) => !d.optional);
  const allUploaded = requiredDocs.every((d) => d.uploaded);
  const requiredUploadedCount = requiredDocs.filter((d) => d.uploaded).length;

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <StatusStepper steps={STEPS} currentStep="documents" className="mb-6" />

        <Text variant="h3" color="inverse" className="mb-1">
          {t('onboarding.step_documents')}
        </Text>
        <Text variant="bodySmall" color="secondary" className="mb-6">
          {t('onboarding.step_n_of_total', { step: 3, total: 4 })} — {requiredUploadedCount}/{requiredDocs.length}
        </Text>

        {documents.map((doc) => (
          <Pressable
            key={doc.document_type}
            onPress={() => handleDocumentPress(doc.document_type)}
            accessibilityRole="button"
            accessibilityLabel={t(DOC_LABELS[doc.document_type])}
          >
            <Card forceDark variant="surface" padding="md" className="mb-3 flex-row items-center">
              {doc.uploading ? (
                <ActivityIndicator size="small" color={midnightEmber.accent[500]} />
              ) : doc.uploaded && doc.mimeType === 'application/pdf' ? (
                <Ionicons name="document-text" size={24} color={midnightEmber.state.success} />
              ) : (
                <Ionicons
                  name={doc.uploaded ? 'checkmark-circle' : 'cloud-upload-outline'}
                  size={24}
                  color={doc.uploaded ? midnightEmber.state.success : midnightEmber.map.text.tertiary}
                />
              )}
              <View className="flex-1 ml-3">
                <View className="flex-row items-center">
                  <Text variant="body" color="inverse">{t(DOC_LABELS[doc.document_type])}</Text>
                  {doc.optional && (
                    <View
                      className="ml-2 px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: midnightEmber.map.bg.elevated }}
                    >
                      <Text variant="badge" color="secondary">
                        {t('onboarding.optional', { defaultValue: 'Opcional' })}
                      </Text>
                    </View>
                  )}
                </View>
                {doc.error ? (
                  <Text variant="caption" color="error">{doc.error}</Text>
                ) : doc.uploaded && doc.mimeType === 'application/pdf' ? (
                  <Text variant="caption" color="accent" numberOfLines={1}>{doc.fileName}</Text>
                ) : (
                  <Text variant="caption" color={doc.uploaded ? 'accent' : 'secondary'}>
                    {doc.uploaded ? t('onboarding.uploaded', { defaultValue: 'Subido' }) : doc.document_type === 'selfie' ? t('onboarding.take_photo') : t('onboarding.pick_from_gallery')}
                  </Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={20} color={midnightEmber.map.text.tertiary} />
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

        {/* BUG-299: escape hatch — driver can switch accounts at any
            onboarding step. Without this they're trapped after OTP. */}
        <SwitchAccountFooter />
      </View>
    </Screen>
  );
}
