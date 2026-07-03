import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, ActivityIndicator, Alert, Platform, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import Toast from 'react-native-toast-message';
import { compressDocument, formatSizeDelta } from '@/lib/compressDocument';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors, midnightEmber, cubanLight, cubanDark } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { ensurePickerPermission } from '@/lib/ensurePickerPermission';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { DriverDocument, SelfieCheck, DocumentType } from '@tricigo/types';

const DOC_TYPE_KEY: Record<string, string> = {
  national_id: 'onboarding.national_id',
  drivers_license: 'onboarding.drivers_license',
  vehicle_registration: 'onboarding.vehicle_registration',
  selfie: 'onboarding.selfie',
  vehicle_photo: 'onboarding.vehicle_photo',
  operating_license: 'onboarding.operating_license',
};

/** Document types that accept PDF uploads in addition to images */
const PDF_ELIGIBLE_TYPES: DocumentType[] = ['national_id', 'drivers_license', 'vehicle_registration', 'operating_license'];

export default function DocumentsScreen() {
  const { t } = useTranslation('driver');
  const { t: tc } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const driverId = useDriverStore((s) => s.profile?.id);
  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [selfieChecks, setSelfieChecks] = useState<SelfieCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reuploading, setReuploading] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!driverId) {
      setLoading(false);
      return;
    }
    try {
      const [docs, checks] = await Promise.all([
        driverService.getDocumentVerificationStatus(driverId),
        driverService.getSelfieChecks(driverId, 5).catch(() => [] as SelfieCheck[]),
      ]);
      setDocuments(docs);
      setSelfieChecks(checks);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Stale-on-mount: refetch verification status on focus / app foreground (an
  // admin approval/rejection should reflect without a full restart).
  useRefreshOnFocus(fetchData);

  const reuploadImage = useCallback(async (docType: DocumentType) => {
    if (!driverId) return;
    const isSelfie = docType === 'selfie';
    const useCamera = isSelfie && Platform.OS !== 'web';
    // Ask for camera/photos permission first (Apple 2.1(a) — avoid the iOS
    // "Missing camera or camera roll permission" throw).
    if (!(await ensurePickerPermission(useCamera ? 'camera' : 'gallery', tc))) return;
    setReuploading(docType);

    try {
      const result = useCamera
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: 'images',
            quality: 0.7,
            cameraType: ImagePicker.CameraType.front,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: 'images',
            quality: 0.7,
          });

      if (result.canceled || !result.assets?.[0]) {
        setReuploading(null);
        return;
      }

      const asset = result.assets[0];
      const fileName = `${docType}-${Date.now()}.jpg`;
      const mimeType = asset.mimeType ?? 'image/jpeg';

      // Compress before upload — see compressDocument.ts docstring for
      // rationale (Cuba connectivity).
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
      await driverService.uploadDocument(driverId, docType, compressed.uri, fileName, uploadMime);
      await fetchData();
    } catch (err) {
      Alert.alert('Error', t('common.error'));
    } finally {
      setReuploading(null);
    }
  }, [driverId, fetchData, t, tc]);

  const reuploadDocument = useCallback(async (docType: DocumentType) => {
    if (!driverId) return;
    setReuploading(docType);

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) {
        setReuploading(null);
        return;
      }

      const asset = result.assets[0];
      const fileName = asset.name ?? `${docType}-${Date.now()}.pdf`;
      const mimeType = asset.mimeType ?? 'application/pdf';

      // PDF passes through compressDocument untouched; images get
      // compressed. Either way we get a smaller payload when possible.
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
      await driverService.uploadDocument(driverId, docType, compressed.uri, fileName, uploadMime);
      await fetchData();
    } catch (err) {
      Alert.alert('Error', t('common.error'));
    } finally {
      setReuploading(null);
    }
  }, [driverId, fetchData, t]);

  const handleReupload = useCallback((docType: DocumentType) => {
    if (PDF_ELIGIBLE_TYPES.includes(docType)) {
      Alert.alert(
        t('onboarding.upload_method', { defaultValue: 'Método de subida' }),
        t('onboarding.choose_upload', { defaultValue: '¿Cómo quieres subir este documento?' }),
        [
          { text: t('onboarding.from_gallery', { defaultValue: 'Foto / Galería' }), onPress: () => reuploadImage(docType) },
          { text: t('onboarding.upload_pdf', { defaultValue: 'Documento (PDF)' }), onPress: () => reuploadDocument(docType) },
          { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        ],
      );
    } else {
      reuploadImage(docType);
    }
  }, [reuploadImage, reuploadDocument, t]);

  const getStatusBadgeProps = (doc: DriverDocument) => {
    if (doc.is_verified) {
      return { variant: 'success' as const, label: t('verification.doc_verified'), icon: 'checkmark-circle' as const };
    }
    if (doc.rejection_reason) {
      return { variant: 'error' as const, label: t('verification.doc_rejected'), icon: 'close-circle' as const };
    }
    return { variant: 'warning' as const, label: t('verification.doc_pending'), icon: 'time-outline' as const };
  };

  const getSelfieStatusProps = (check: SelfieCheck) => {
    switch (check.status) {
      case 'passed': return { variant: 'success' as const, label: t('verification.passed'), icon: 'checkmark-circle' as const };
      case 'failed': return { variant: 'error' as const, label: t('verification.failed'), icon: 'close-circle' as const };
      case 'processing': return { variant: 'info' as const, label: t('verification.processing'), icon: 'sync-outline' as const };
      case 'expired': return { variant: 'neutral' as const, label: t('verification.expired'), icon: 'time-outline' as const };
      default: return { variant: 'warning' as const, label: t('verification.doc_pending'), icon: 'time-outline' as const };
    }
  };

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); fetchData(); }} />;

  return (
    <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4">
        <ProfileScreenHeader
          title={t('profile.documents', { defaultValue: 'Documentos' })}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back', { defaultValue: 'Volver' })}
        />

        {loading ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color={colors.brand.orange} />
          </View>
        ) : documents.length === 0 ? (
          <EmptyState
            icon="document-text-outline"
            title={t('verification.no_documents', { defaultValue: 'No hay documentos' })}
            description={t('verification.no_documents_desc', { defaultValue: 'Aún no has cargado documentos de verificación' })}
          />
        ) : (
          <>
            {documents.map((doc) => {
              const badgeProps = getStatusBadgeProps(doc);
              const isRejected = !doc.is_verified && !!doc.rejection_reason;
              const isPdf = doc.mime_type === 'application/pdf' || doc.file_name?.toLowerCase().endsWith('.pdf');

              return (
                <Card theme="light" key={doc.id} variant="surface" padding="md" className="mb-3">
                  <View className="flex-row items-center">
                    <View className="w-10 h-10 rounded-xl items-center justify-center mr-3" style={{ backgroundColor: midnightEmber.screen.bg.sunken }}>
                      <Ionicons
                        name={isPdf ? 'document-text' : doc.is_verified ? 'checkmark-circle' : isRejected ? 'close-circle' : 'document-text'}
                        size={20}
                        color={doc.is_verified ? midnightEmber.state.success : isRejected ? midnightEmber.state.danger : midnightEmber.accent[500]}
                      />
                    </View>
                    <View className="flex-1">
                      <Text variant="body" color="primary">
                        {DOC_TYPE_KEY[doc.document_type] ? t(DOC_TYPE_KEY[doc.document_type]!) : doc.document_type}
                      </Text>
                      <Text variant="caption" color="secondary" className="mt-0.5" numberOfLines={1}>
                        {isPdf ? `PDF: ${doc.file_name}` : doc.file_name}
                      </Text>
                      {isRejected && doc.rejection_reason && (
                        <View className="flex-row items-start mt-1.5">
                          <Ionicons name="alert-circle" size={12} color={midnightEmber.state.danger} style={{ marginTop: 2, marginRight: 4 }} />
                          <Text variant="caption" color="error" className="flex-1">
                            {t('verification.rejection_reason', { reason: doc.rejection_reason })}
                          </Text>
                        </View>
                      )}
                    </View>
                    <View className="items-end ml-2">
                      <StatusBadge {...badgeProps} />
                      <Text variant="badge" color="secondary" className="mt-1.5">
                        {new Date(doc.uploaded_at).toLocaleDateString('es-CU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Havana' })}
                      </Text>
                    </View>
                  </View>

                  {isRejected && (
                    <Button
                      title={t('verification.reupload')}
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onPress={() => handleReupload(doc.document_type)}
                      loading={reuploading === doc.document_type}
                    />
                  )}

                  {doc.face_match_score != null && (
                    <View className="flex-row items-center mt-3 rounded-lg px-3 py-2" style={{ backgroundColor: midnightEmber.screen.bg.sunken }}>
                      <Ionicons name="scan-outline" size={14} color={midnightEmber.screen.text.tertiary} />
                      <Text variant="caption" color="secondary" className="ml-2 flex-1">
                        Face match
                      </Text>
                      <View className="flex-1 h-1.5 rounded-full mx-2" style={{ backgroundColor: midnightEmber.screen.line.default }}>
                        <View
                          className="h-1.5 rounded-full"
                          style={{
                            width: `${Math.round(doc.face_match_score * 100)}%`,
                            backgroundColor: doc.face_match_score >= 0.7 ? colors.profit.high : doc.face_match_score >= 0.4 ? colors.profit.medium : colors.profit.low,
                          }}
                        />
                      </View>
                      <Text variant="badge" style={{ color: doc.face_match_score >= 0.7 ? colors.profit.high : colors.profit.medium }}>
                        {Math.round(doc.face_match_score * 100)}%
                      </Text>
                    </View>
                  )}
                </Card>
              );
            })}

            {selfieChecks.length > 0 && (
              <View className="mt-6">
                <Text variant="label" color="secondary" className="mb-3">
                  {t('verification.selfie_history', { defaultValue: 'Verificaciones de Selfie' })}
                </Text>
                {selfieChecks.map((check) => {
                  const badgeProps = getSelfieStatusProps(check);
                  return (
                    <Card theme="light" key={check.id} variant="surface" padding="sm" className="mb-2">
                      <View className="flex-row items-center">
                        <View className="w-8 h-8 rounded-lg items-center justify-center mr-3" style={{ backgroundColor: midnightEmber.screen.bg.sunken }}>
                          <Ionicons name="camera-outline" size={16} color={midnightEmber.screen.text.tertiary} />
                        </View>
                        <Text variant="caption" color="primary" className="flex-1">
                          {new Date(check.requested_at).toLocaleDateString('es-CU', {
                            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Havana',
                          })}
                        </Text>
                        {check.face_match_score != null && (
                          <Text variant="badge" color="secondary" className="mr-2">
                            {Math.round(check.face_match_score * 100)}%
                          </Text>
                        )}
                        <StatusBadge {...badgeProps} />
                      </View>
                    </Card>
                  );
                })}
              </View>
            )}
          </>
        )}
      </View>
      </View>
    </Screen>
  );
}
