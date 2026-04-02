import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, FlatList, Share, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { Skeleton } from '@tricigo/ui/Skeleton';
import { colors, darkColors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { referralService } from '@tricigo/api';
import { formatCUP, getErrorMessage, triggerHaptic } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore } from '@/stores/theme.store';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { Referral } from '@tricigo/types';

const STATUS_DISPLAY: Record<string, { bg: string; text: string; key: string }> = {
  pending: { bg: 'bg-yellow-100', text: 'text-yellow-700', key: 'profile.referral_status_pending' },
  rewarded: { bg: 'bg-green-100', text: 'text-green-700', key: 'profile.referral_status_rewarded' },
  invalidated: { bg: 'bg-red-100', text: 'text-red-700', key: 'profile.referral_status_invalidated' },
};

export default function ReferralScreen() {
  const { t } = useTranslation('common');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const userId = useAuthStore((s) => s.user?.id);

  const [myCode, setMyCode] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [hasBeenReferred, setHasBeenReferred] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleCopyCode = async () => {
    if (!myCode) return;
    await Clipboard.setStringAsync(myCode);
    Toast.show({ type: 'success', text1: t('copied') });
    triggerHaptic('light');
  };

  const handleShare = async () => {
    try {
      await Share.share({
        message: t('profile.referral_share_message', { code: myCode }),
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
      Toast.show({ type: 'success', text1: t('profile.referral_success_title'), text2: t('profile.referral_success_message') });
      setInputCode('');
      setHasBeenReferred(true);
      fetchData();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('profile.referral_error');
      Toast.show({ type: 'error', text1: t('error'), text2: message });
    } finally {
      setSubmitting(false);
    }
  };

  const renderReferral = ({ item }: { item: Referral }) => {
    const display = STATUS_DISPLAY[item.status] ?? { bg: 'bg-yellow-100', text: 'text-yellow-700', key: 'profile.referral_status_pending' };
    return (
      <Card variant="outlined" padding="md" className="mb-2">
        <View className="flex-row items-center justify-between">
          <View className="flex-1 mr-2">
            <Text variant="bodySmall" numberOfLines={1}>
              {t('profile.referral_item', { id: item.id.substring(0, 8) })}
            </Text>
            <Text variant="caption" color="tertiary" className="mt-0.5">
              {new Date(item.created_at).toLocaleDateString('es-CU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
              {' · '}
              {t('profile.referral_bonus', { amount: formatCUP(item.bonus_amount) })}
            </Text>
          </View>
          <StatusBadge
            label={t(display.key)}
            variant={item.status === 'rewarded' ? 'success' : item.status === 'invalidated' ? 'error' : 'warning'}
          />
        </View>
      </Card>
    );
  };

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); fetchData(); }} />;

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <ScreenHeader title={t('profile.referral_title')} onBack={() => router.back()} />

        <FlatList
          data={referrals}
          keyExtractor={(item) => item.id}
          renderItem={renderReferral}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#FF4D00" />
          }
          ListHeaderComponent={
            <View>
              {/* My Code Section */}
              <Card variant="filled" padding="lg" className="mb-6 bg-primary-50 items-center">
                <Text variant="bodySmall" color="secondary" className="mb-2">
                  {t('profile.referral_your_code')}
                </Text>
                {loading && !myCode ? (
                  <View className="mb-3">
                    <Skeleton width={160} height={32} />
                  </View>
                ) : (
                <Pressable onPress={handleCopyCode} className="flex-row items-center mb-3">
                  <Text variant="h2" color="primary" className="tracking-widest">
                    {myCode || '...'}
                  </Text>
                  {myCode ? (
                    <Ionicons name="copy-outline" size={20} color={isDark ? colors.primary[400] : colors.primary[500]} style={{ marginLeft: 8 }} />
                  ) : null}
                </Pressable>
                )}
                <Button
                  title={t('profile.referral_share')}
                  variant="primary"
                  size="md"
                  onPress={handleShare}
                  disabled={!myCode}
                />
                <Text variant="caption" color="tertiary" className="mt-3 text-center">
                  {t('profile.referral_share_help', { bonus: formatCUP(500) })}
                </Text>
              </Card>

              {/* Apply Code Section */}
              {!hasBeenReferred && (
                <Card variant="outlined" padding="md" className="mb-6">
                  <Text variant="body" className="font-semibold mb-3">
                    {t('profile.referral_have_code')}
                  </Text>
                  <Input
                    label=""
                    placeholder={t('profile.referral_enter_code')}
                    value={inputCode}
                    onChangeText={setInputCode}
                    autoCapitalize="characters"
                  />
                  <Button
                    title={t('profile.referral_apply')}
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
                    <Ionicons name="checkmark-circle" size={20} color={colors.success.DEFAULT} />
                    <Text variant="bodySmall" color="secondary" className="ml-2">
                      {t('profile.referral_already_applied')}
                    </Text>
                  </View>
                </Card>
              )}

              {/* History header */}
              {referrals.length > 0 && (
                <Text variant="h4" className="mb-3">{t('profile.referral_history')}</Text>
              )}
            </View>
          }
          ListEmptyComponent={
            !loading ? (
              <EmptyState
                icon="gift-outline"
                title={t('profile.referral_empty')}
              />
            ) : null
          }
        />
      </View>
    </Screen>
  );
}
