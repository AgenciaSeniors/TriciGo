import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { ensureDriverProfile } from '@/lib/ensureDriverProfile';
import {
  markPickerLaunch,
  clearPickerMarker,
  consumeRecoveredPickerAsset,
} from '@/lib/cameraRecovery';
import type { DocumentType } from '@tricigo/types';

const RECOVERY_FLOW = 'onboarding-doc';

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
    hydrateUploadedDocuments,
  } = useOnboardingStore();

  // Tracks the eager profile-creation so the UI can show progress / retry
  // instead of a dead-end generic error when the driver taps a document tile
  // before the profile exists (slow Cuban connections, transient failures).
  const [profileState, setProfileState] = useState<'creating' | 'ready' | 'error'>(
    driverProfileId ? 'ready' : 'creating',
  );
  /**
   * Idempotently resolve the driver profile id, creating it if needed. Delegates
   * to the shared ensureDriverProfile() (module-level dedupe + get-first-create +
   * UNIQUE(user_id)-race recovery) so the SAME resolution runs whether it was
   * kicked off early (vehicle-info, step 2) or here on the Documents step as a
   * backstop. Returns null on failure so callers keep the recoverable
   * retry-on-tap UX instead of a dead-end error.
   */
  const ensureProfile = useCallback(
    (): Promise<string | null> => (user ? ensureDriverProfile(user.id) : Promise.resolve(null)),
    [user],
  );

  // Create the driver profile eagerly on mount so tapping a tile is instant.
  useEffect(() => {
    if (driverProfileId || !user) return;
    let cancelled = false;
    setProfileState('creating');
    ensureProfile().then((id) => {
      if (!cancelled) setProfileState(id ? 'ready' : 'error');
    });
    return () => {
      cancelled = true;
    };
  }, [driverProfileId, user, ensureProfile]);

  // Resume: mark docs already on the server as uploaded. The draft store is
  // in-memory, so an app restart (or a connection drop that kills the app
  // mid-onboarding — routine in Cuba) wipes every `uploaded` flag while the
  // files are still in driver_documents. Without this the driver re-uploads
  // everything on each attempt and, if one doc never lands, Submit stays
  // disabled forever. Hydration NEVER clobbers local progress — the store only
  // touches pristine drafts.
  const [hydrating, setHydrating] = useState(false);
  const hydratedProfileRef = useRef<string | null>(null);
  useEffect(() => {
    if (!driverProfileId || hydratedProfileRef.current === driverProfileId) return;
    // Claim before awaiting so a re-render (or StrictMode double-mount) can't
    // fire a second fetch for the same profile.
    hydratedProfileRef.current = driverProfileId;
    let cancelled = false;
    setHydrating(true);
    driverService
      .getDocuments(driverProfileId)
      .then((docs) => {
        if (!cancelled) hydrateUploadedDocuments(docs);
      })
      .catch((err) => {
        // Offline / transient: leave the drafts as-is and let the driver upload
        // normally. Releasing the claim lets a later remount retry. Never
        // surfaced as an error — nothing the driver can act on, and a failed
        // hydration only costs a redundant re-upload.
        if (!cancelled) hydratedProfileRef.current = null;
        console.warn('[Documents] Hydration failed:', getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [driverProfileId, hydrateUploadedDocuments]);

  /** Document types that accept PDF uploads in addition to images */
  const PDF_ELIGIBLE_TYPES: DocumentType[] = ['national_id', 'drivers_license', 'vehicle_registration', 'operating_license'];

  const uploadFile = async (docType: DocumentType, uri: string, fileName: string, mimeType?: string) => {
    // Read the id fresh from the store (not the closed-over render value): a tap
    // that just triggered ensureProfile() sets it via setState, but this closure
    // would still see the stale null. Fall back to ensureProfile() as a last resort.
    const profileId = useOnboardingStore.getState().driverProfileId ?? (await ensureProfile());
    if (!profileId) {
      setDocumentError(docType, t('onboarding.error_upload_failed'));
      return;
    }
    setDocumentUri(docType, uri, fileName, mimeType);
    setDocumentUploading(docType, true);
    try {
      console.log('[Documents] Uploading:', docType, 'profileId:', profileId, 'mime:', mimeType);
      // Outer budget must OUTLAST uploadFileFromUri's own bound (45s/attempt ×2
      // + 2s backoff ≈ 92s worst case) or it fires mid-retry: the UI would show
      // an error while the background retry still succeeds. 100s also bounds
      // the post-upload PostgREST insert, which has no timeout of its own.
      const uploadPromise = driverService.uploadDocument(profileId, docType, uri, fileName, mimeType);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Upload timeout after 100s')), 100_000),
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

  const pickImage = async (docType: DocumentType, source?: 'camera' | 'gallery') => {
    // An explicit `source` always wins; otherwise the selfie defaults to the
    // front camera and every other doc to the gallery.
    //
    // The selfie used to be camera-ONLY. That made it a dead-end: Android stops
    // showing the permission dialog after two denials, so a driver who denied
    // the camera hit "Necesitamos acceso a la cámara" forever on the one
    // REQUIRED doc with no alternative — Submit could never enable (2026-07-17).
    // The gallery escape hatch mirrors vehicle_photo (#803), which needs it for
    // a different reason: Google Photos' picker fails to load on Cuba's flaky
    // link and shows its own "Se produjo un error, vuelve a intentarlo más
    // tarde" dialog (a Google error, external to the app). Between the two,
    // every required photo now has both routes.
    const isSelfie = docType === 'selfie';
    const isWeb = Platform.OS === 'web';
    const useCamera = !isWeb && (source ? source === 'camera' : isSelfie);

    if (!isWeb) {
      if (useCamera) {
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

    // Mark the launch: on low-RAM Android the OS may kill our process while
    // the camera (or Google Photos) is foregrounded. The marker lets the
    // relaunched app recover the photo and resume the upload (cameraRecovery.ts).
    await markPickerLaunch(RECOVERY_FLOW, { docType });
    const result = useCamera
      ? await ImagePicker.launchCameraAsync(
          isSelfie
            ? { quality: 0.7, allowsEditing: true, cameraType: ImagePicker.CameraType.front }
            // Vehicle photo is rectangular — back camera, no forced square crop.
            : { mediaTypes: ['images'], quality: 0.7, allowsEditing: false },
        )
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 0.7,
          // Documents (ID, license, registration, vehicle photo) are rectangular.
          // The forced OS square-crop window was far too cramped to frame a whole
          // document, so skip editing and upload the full photo for human review.
          allowsEditing: false,
        });
    await clearPickerMarker(); // returned alive — no recovery needed

    if (result.canceled || !result.assets[0]) return;
    await processPickedAsset(docType, result.assets[0]);
  };

  // Shared tail of pickImage (compress + upload) — also the re-entry point for
  // the recovery path after Android killed the app mid-capture.
  const processPickedAsset = async (docType: DocumentType, asset: ImagePicker.ImagePickerAsset) => {
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

  // Recovery: if Android killed the app while a picker was open for one of the
  // document tiles, resume the compress+upload with the recovered photo. The
  // consume is one-shot, so the mount-only effect is safe; uploadFile resolves
  // the profile id fresh from the store (or re-creates it) on its own.
  useEffect(() => {
    let cancelled = false;
    consumeRecoveredPickerAsset(RECOVERY_FLOW).then((rec) => {
      if (cancelled || !rec) return;
      const docType = rec.meta.docType as DocumentType | undefined;
      if (!docType || !(docType in DOC_LABELS)) return;
      void processPickedAsset(docType, rec.asset);
    });
    return () => { cancelled = true; };
    // processPickedAsset is a plain per-render function; the consume is
    // one-shot so running this only on mount is both safe and intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleDocumentPress = async (docType: DocumentType) => {
    // Ensure the profile exists BEFORE opening the picker so the driver never
    // frames a photo only to have the upload silently fail. If it's still being
    // created (or a previous attempt failed), await/retry here — each tap is a
    // fresh retry — and only surface a friendly, recoverable message on failure.
    let profileId = useOnboardingStore.getState().driverProfileId;
    if (!profileId) {
      setProfileState('creating');
      profileId = await ensureProfile();
      setProfileState(profileId ? 'ready' : 'error');
      if (!profileId) {
        Alert.alert(
          t('onboarding.profile_setup_failed_title', { defaultValue: 'Un momento' }),
          t('onboarding.profile_setup_failed_body', {
            defaultValue: 'No pudimos preparar tu perfil. Revisa tu conexión y toca de nuevo para reintentar.',
          }),
        );
        return;
      }
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
    } else if (docType === 'vehicle_photo' || docType === 'selfie') {
      // Camera first (the natural action for both), gallery as the escape hatch
      // — vehicle_photo to bypass Google Photos, selfie so a denied camera
      // permission can't dead-end the whole registration. See pickImage.
      Alert.alert(
        t(DOC_LABELS[docType]),
        t('onboarding.choose_photo_source', { defaultValue: '¿Cómo quieres agregar la foto?' }),
        [
          { text: t('onboarding.take_photo', { defaultValue: 'Tomar foto' }), onPress: () => pickImage(docType, 'camera') },
          { text: t('onboarding.pick_from_gallery', { defaultValue: 'Seleccionar de galería' }), onPress: () => pickImage(docType, 'gallery') },
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
        <Text variant="bodySmall" color="secondary" className="mb-6" style={{ color: midnightEmber.map.text.secondary }}>
          {t('onboarding.step_n_of_total', { step: 3, total: 4 })} — {requiredUploadedCount}/{requiredDocs.length}
        </Text>

        {!driverProfileId && profileState === 'creating' && (
          <View className="flex-row items-center mb-4">
            <ActivityIndicator size="small" color={midnightEmber.accent[500]} />
            <Text variant="caption" color="secondary" className="ml-2" style={{ color: midnightEmber.map.text.secondary }}>
              {t('onboarding.preparing_profile', { defaultValue: 'Preparando tu perfil…' })}
            </Text>
          </View>
        )}
        {hydrating && (
          <View className="flex-row items-center mb-4">
            <ActivityIndicator size="small" color={midnightEmber.accent[500]} />
            <Text variant="caption" color="secondary" className="ml-2" style={{ color: midnightEmber.map.text.secondary }}>
              {t('onboarding.checking_uploaded', { defaultValue: 'Revisando documentos ya subidos…' })}
            </Text>
          </View>
        )}
        {!driverProfileId && profileState === 'error' && (
          <Pressable
            onPress={() => {
              setProfileState('creating');
              ensureProfile().then((id) => setProfileState(id ? 'ready' : 'error'));
            }}
            accessibilityRole="button"
            className="flex-row items-center mb-4"
          >
            <Ionicons name="refresh" size={16} color={midnightEmber.state.danger} />
            <Text variant="caption" color="error" className="ml-2">
              {t('onboarding.profile_setup_retry', { defaultValue: 'No pudimos preparar tu perfil. Toca para reintentar.' })}
            </Text>
          </Pressable>
        )}

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
                      <Text variant="badge" color="secondary" style={{ color: midnightEmber.map.text.secondary }}>
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
                  <Text variant="caption" color={doc.uploaded ? 'accent' : 'secondary'} style={doc.uploaded ? undefined : { color: midnightEmber.map.text.secondary }}>
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
