import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, FlatList, Alert, Share } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { useTranslation } from '@tricigo/i18n';
import { referralService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import type { Referral } from '@tricigo/types';

const STATUS_DISPLAY: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'Pendiente' },
  rewarded: { bg: 'bg-green-100', text: 'text-green-700', label: 'Recompensado' },
  invalidated: { bg: 'bg-red-100', text: 'text-red-700', label: 'Invalidado' },
};

export default function ReferralScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);

  const [myCode, setMyCode] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [hasBeenReferred, setHasBeenReferred] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      const [code, history, referred] = await Promise.all([
        referralService.getOrCreateReferralCode(userId),
        referralService.getReferralHistory(userId),
        referralService.hasBeenReferred(userId),
      ]);
      setMyCode(code);
      setReferrals(history);
      setHasBeenReferred(referred);
    } catch (err) {
      console.warn('[Referral] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleShare = async () => {
    try {
      await Share.share({
        message: `Usa mi código de referido ${myCode} en TriciGo y gana un bono. Descarga la app: https://tricigo.app`,
      });
    } catch {
      /* user cancelled share */
    }
  };

  const handleApplyCode = async () => {
    if (!userId || !inputCode.trim()) return;
    setSubmitting(true);
    try {
      await referralService.applyReferralCode(userId, inputCode.trim());
      Alert.alert('Referido', 'Código aplicado exitosamente. Recibirás tu bono pronto.');
      setInputCode('');
      setHasBeenReferred(true);
      fetchData();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo aplicar el código.';
      Alert.alert('Error', message);
    } finally {
      setSubmitting(false);
    }
  };

  const renderReferral = ({ item }: { item: Referral }) => {
    const display = STATUS_DISPLAY[item.status] ?? { bg: 'bg-yellow-100', text: 'text-yellow-700', label: item.status };
    return (
      <Card variant="outlined" padding="md" className="mb-2">
        <View className="flex-row items-center justify-between">
          <View className="flex-1 mr-2">
            <Text variant="bodySmall" numberOfLines={1}>
              Referido #{item.id.substring(0, 8)}
            </Text>
            <Text variant="caption" color="tertiary" className="mt-0.5">
              {new Date(item.created_at).toLocaleDateString('es-CU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
              {' · '}
              Bono: {formatCUP(item.bonus_amount)}
            </Text>
          </View>
          <View className={`px-2 py-0.5 rounded-full ${display.bg}`}>
            <Text className={`text-xs font-medium ${display.text}`}>
              {display.label}
            </Text>
          </View>
        </View>
      </Card>
    );
  };

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#171717" />
          </Pressable>
          <Text variant="h3">Referidos</Text>
        </View>

        <FlatList
          data={referrals}
          keyExtractor={(item) => item.id}
          renderItem={renderReferral}
          ListHeaderComponent={
            <View>
              {/* My Code Section */}
              <Card variant="filled" padding="lg" className="mb-6 bg-primary-50 items-center">
                <Text variant="bodySmall" color="secondary" className="mb-2">
                  Tu código de referido
                </Text>
                <Text variant="h2" color="primary" className="mb-3 tracking-widest">
                  {myCode || '...'}
                </Text>
                <Button
                  title="Compartir código"
                  variant="primary"
                  size="md"
                  onPress={handleShare}
                  disabled={!myCode}
                />
                <Text variant="caption" color="tertiary" className="mt-3 text-center">
                  Comparte tu código con amigos. Ambos recibirán un bono de {formatCUP(50000)} cuando completen su primer viaje.
                </Text>
              </Card>

              {/* Apply Code Section */}
              {!hasBeenReferred && (
                <Card variant="outlined" padding="md" className="mb-6">
                  <Text variant="body" className="font-semibold mb-3">
                    ¿Tienes un código de referido?
                  </Text>
                  <Input
                    label=""
                    placeholder="Ingresa el código"
                    value={inputCode}
                    onChangeText={setInputCode}
                    autoCapitalize="characters"
                  />
                  <Button
                    title="Aplicar código"
                    variant="outline"
                    size="md"
                    fullWidth
                    onPress={handleApplyCode}
                    loading={submitting}
                    disabled={!inputCode.trim() || submitting}
                    className="mt-2"
                  />
                </Card>
              )}

              {hasBeenReferred && (
                <Card variant="outlined" padding="md" className="mb-6">
                  <View className="flex-row items-center">
                    <Ionicons name="checkmark-circle" size={20} color="#22C55E" />
                    <Text variant="bodySmall" color="secondary" className="ml-2">
                      Ya aplicaste un código de referido
                    </Text>
                  </View>
                </Card>
              )}

              {/* History header */}
              {referrals.length > 0 && (
                <Text variant="h4" className="mb-3">Mis referidos</Text>
              )}
            </View>
          }
          ListEmptyComponent={
            !loading ? (
              <View className="items-center py-6">
                <Text variant="bodySmall" color="tertiary">
                  Aún no has referido a nadie
                </Text>
              </View>
            ) : null
          }
        />
      </View>
    </Screen>
  );
}
