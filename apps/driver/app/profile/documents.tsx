import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { useDriverStore } from '@/stores/driver.store';
import type { DriverDocument, SelfieCheck, DocumentType } from '@tricigo/types';

const DOC_TYPE_KEY: Record<string, string> = {
  national_id: 'onboarding.national_id',
  drivers_license: 'onboarding.drivers_license',
  vehicle_registration: 'onboarding.vehicle_registration',
  selfie: 'onboarding.selfie',
  vehicle_photo: 'onboarding.vehicle_photo',
};

export default function DocumentsScreen() {
  const { t } = useTranslation('driver');
  const driverId = useDriverStore((s) => s.profile?.id);
  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [selfieChecks, setSelfieChecks] = useState<SelfieCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [reuploading, setReuploading] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!driverId) return;
    try {
      const [docs, checks] = await Promise.all([
        driverService.getDocumentVerificationStatus(driverId),
        driverService.getSelfieChecks(driverId, 5),
      ]);
      setDocuments(docs);
      setSelfieChecks(checks);
    } catch (err) {
      console.error('Error fetching documents:', err);
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleReupload = useCallback(async (docType: DocumentType) => {
    if (!driverId) return;
    setReuploading(docType);

    try {
      const isSelfie = docType === 'selfie';
      const result = isSelfie
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
      await driverService.uploadDocument(driverId, docType, asset.uri, fileName);
      await fetchData();
    } catch (err) {
      Alert.alert('Error', t('common.error'));
    } finally {
      setReuploading(null);
    }
  }, [driverId, fetchData, t]);

  const getStatusBadge = (doc: DriverDocument) => {
    if (doc.is_verified) {
      return { bg: 'bg-green-900', text: 'text-green-400', label: t('verification.doc_verified') };
    }
    if (doc.rejection_reason) {
      return { bg: 'bg-red-900', text: 'text-red-400', label: t('verification.doc_rejected') };
    }
    return { bg: 'bg-yellow-900', text: 'text-yellow-400', label: t('verification.doc_pending') };
  };

  const getSelfieStatusBadge = (check: SelfieCheck) => {
    switch (check.status) {
      case 'passed': return { bg: 'bg-green-900', text: 'text-green-400', label: t('verification.passed') };
      case 'failed': return { bg: 'bg-red-900', text: 'text-red-400', label: t('verification.failed') };
      case 'processing': return { bg: 'bg-blue-900', text: 'text-blue-400', label: t('verification.processing') };
      case 'expired': return { bg: 'bg-neutral-700', text: 'text-neutral-400', label: t('verification.expired') };
      default: return { bg: 'bg-yellow-900', text: 'text-yellow-400', label: t('verification.doc_pending') };
    }
  };

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#FAFAFA" />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.documents', { defaultValue: 'Documentos' })}</Text>
        </View>

        {loading ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color={colors.brand.orange} />
          </View>
        ) : documents.length === 0 ? (
          <View className="items-center py-20">
            <Text variant="body" color="inverse" className="opacity-50">
              {t('verification.no_documents', { defaultValue: 'No hay documentos cargados' })}
            </Text>
          </View>
        ) : (
          <>
            {documents.map((doc) => {
              const badge = getStatusBadge(doc);
              const isRejected = !doc.is_verified && !!doc.rejection_reason;

              return (
                <Card key={doc.id} variant="filled" padding="md" className="mb-3 bg-neutral-800">
                  <View className="flex-row items-center">
                    <View className="w-10 h-10 rounded-lg bg-neutral-700 items-center justify-center mr-3">
                      <Ionicons
                        name={doc.is_verified ? 'checkmark-circle' : isRejected ? 'close-circle' : 'document-text'}
                        size={20}
                        color={doc.is_verified ? colors.success.DEFAULT : isRejected ? colors.error.DEFAULT : colors.brand.orange}
                      />
                    </View>
                    <View className="flex-1">
                      <Text variant="body" color="inverse">
                        {DOC_TYPE_KEY[doc.document_type] ? t(DOC_TYPE_KEY[doc.document_type]!) : doc.document_type}
                      </Text>
                      <Text variant="caption" color="inverse" className="opacity-50">
                        {doc.file_name}
                      </Text>
                      {isRejected && doc.rejection_reason && (
                        <Text variant="caption" className="text-red-400 mt-1">
                          {t('verification.rejection_reason', { reason: doc.rejection_reason })}
                        </Text>
                      )}
                    </View>
                    <View className="items-end">
                      <View className={`px-2 py-0.5 rounded-full ${badge.bg}`}>
                        <Text variant="caption" className={badge.text}>
                          {badge.label}
                        </Text>
                      </View>
                      <Text variant="caption" color="inverse" className="opacity-40 mt-1">
                        {new Date(doc.uploaded_at).toLocaleDateString('es-CU', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </Text>
                    </View>
                  </View>

                  {/* Re-upload button for rejected documents */}
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

                  {/* Face match score if available */}
                  {doc.face_match_score != null && (
                    <View className="flex-row items-center mt-2">
                      <Ionicons name="scan-outline" size={14} color={colors.neutral[400]} />
                      <Text variant="caption" color="inverse" className="opacity-50 ml-1">
                        Score: {Math.round(doc.face_match_score * 100)}%
                      </Text>
                    </View>
                  )}
                </Card>
              );
            })}

            {/* Selfie checks history */}
            {selfieChecks.length > 0 && (
              <View className="mt-6">
                <Text variant="label" color="inverse" className="mb-3 opacity-70">
                  {t('verification.selfie_history', { defaultValue: 'Verificaciones de Selfie' })}
                </Text>
                {selfieChecks.map((check) => {
                  const badge = getSelfieStatusBadge(check);
                  return (
                    <Card key={check.id} variant="filled" padding="sm" className="mb-2 bg-neutral-800">
                      <View className="flex-row items-center">
                        <Ionicons name="camera-outline" size={18} color={colors.neutral[400]} />
                        <Text variant="caption" color="inverse" className="flex-1 ml-2">
                          {new Date(check.requested_at).toLocaleDateString('es-CU', {
                            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                          })}
                        </Text>
                        {check.face_match_score != null && (
                          <Text variant="caption" color="inverse" className="opacity-50 mr-2">
                            {Math.round(check.face_match_score * 100)}%
                          </Text>
                        )}
                        <View className={`px-2 py-0.5 rounded-full ${badge.bg}`}>
                          <Text variant="caption" className={badge.text}>
                            {badge.label}
                          </Text>
                        </View>
                      </View>
                    </Card>
                  );
                })}
              </View>
            )}
          </>
        )}
      </View>
    </Screen>
  );
}
