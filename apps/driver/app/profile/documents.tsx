import React, { useEffect, useState } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { driverService } from '@tricigo/api/services/driver';
import { useDriverStore } from '@/stores/driver.store';
import type { DriverDocument } from '@tricigo/types';

const DOC_TYPE_LABEL: Record<string, string> = {
  identity_card: 'Carnet de identidad',
  driver_license: 'Licencia de conducción',
  vehicle_registration: 'Circulación',
  insurance: 'Seguro',
  photo: 'Foto',
};

export default function DocumentsScreen() {
  const { t } = useTranslation('common');
  const driverId = useDriverStore((s) => s.profile?.id);
  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!driverId) return;
    let cancelled = false;

    async function fetch() {
      try {
        const data = await driverService.getDocuments(driverId!);
        if (!cancelled) setDocuments(data);
      } catch (err) {
        console.error('Error fetching documents:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetch();
    return () => { cancelled = true; };
  }, [driverId]);

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#FAFAFA" />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.documents')}</Text>
        </View>

        {loading ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color={colors.brand.orange} />
          </View>
        ) : documents.length === 0 ? (
          <View className="items-center py-20">
            <Text variant="body" color="inverse" className="opacity-50">
              No hay documentos cargados
            </Text>
          </View>
        ) : (
          documents.map((doc) => (
            <Card key={doc.id} variant="filled" padding="md" className="mb-3 bg-neutral-800">
              <View className="flex-row items-center">
                <View className="w-10 h-10 rounded-lg bg-neutral-700 items-center justify-center mr-3">
                  <Ionicons name="document-text" size={20} color={colors.brand.orange} />
                </View>
                <View className="flex-1">
                  <Text variant="body" color="inverse">
                    {DOC_TYPE_LABEL[doc.document_type] ?? doc.document_type}
                  </Text>
                  <Text variant="caption" color="inverse" className="opacity-50">
                    {doc.file_name}
                  </Text>
                </View>
                <View className="items-end">
                  <View className={`px-2 py-0.5 rounded-full ${doc.is_verified ? 'bg-green-900' : 'bg-yellow-900'}`}>
                    <Text variant="caption" className={doc.is_verified ? 'text-green-400' : 'text-yellow-400'}>
                      {doc.is_verified ? 'Verificado' : 'Pendiente'}
                    </Text>
                  </View>
                  <Text variant="caption" color="inverse" className="opacity-40 mt-1">
                    {new Date(doc.uploaded_at).toLocaleDateString('es-CU', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </Text>
                </View>
              </View>
            </Card>
          ))
        )}
      </View>
    </Screen>
  );
}
