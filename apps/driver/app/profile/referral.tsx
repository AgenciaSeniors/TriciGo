import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList, Alert, Share, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { cubanLight, cubanDark } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { referralService, walletService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import type { Referral } from '@tricigo/types';

const STATUS_DISPLAY: Record<string, { key: string }> = {
  pending: { key: 'profile.referral_status_pending' },
  rewarded: { key: 'profile.referral_status_rewarded' },
  invalidated: { key: 'profile.referral_status_invalidated' },
};

export default function DriverReferralScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;

  const [myCode, setMyCode] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [hasBeenReferred, setHasBeenReferred] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  // PASS #3 REFERRAL-HARDCODE: bonus is admin-configurable (mig 00395,
  // platform_config.referral_bonus_cup). Default 500 until fetched.
  const [bonusCup, setBonusCup] = useState(500);

  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      const [code, history, referred, bonusRaw] = await Promise.all([
        referralService.getOrCreateReferralCode(userId),
        referralService.getReferralHistory(userId),
        referralService.hasBeenReferred(userId),
        walletService.getConfigValue('referral_bonus_cup').catch(() => null),
      ]);
      setMyCode(code);
      setReferrals(history);
      setHasBeenReferred(referred);
      const parsedBonus = bonusRaw != null ? parseInt(bonusRaw, 10) : NaN;
      if (Number.isFinite(parsedBonus) && parsedBonus > 0) setBonusCup(parsedBonus);
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
      Alert.alert(t('profile.referral_success_title'), t('profile.referral_success_message'));
      setInputCode('');
      setHasBeenReferred(true);
      fetchData();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('profile.referral_error');
      Alert.alert(t('error'), message);
    } finally {
      setSubmitting(false);
    }
  };

  const renderReferral = ({ item }: { item: Referral }) => {
    const display = STATUS_DISPLAY[item.status] ?? { key: 'profile.referral_status_pending' };
    return (
      <Card theme="light" variant="filled" padding="md" className="mb-2 bg-white">
        <View className="flex-row items-center justify-between">
          <View className="flex-1 mr-2">
            <Text variant="bodySmall" color="primary" numberOfLines={1}>
              {t('profile.referral_item', { id: item.id.substring(0, 8) })}
            </Text>
            <Text variant="caption" color="primary" className="mt-0.5 opacity-50">
              {new Date(item.created_at).toLocaleDateString('es-CU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
              {' \u00b7 '}
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

  return (
    <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }} className="pt-4">
        <ScreenHeader
          title={t('profile.referral_title')}
          onBack={() => router.back()}
        />

        <FlatList
          data={referrals}
          keyExtractor={(item) => item.id}
          renderItem={renderReferral}
          ListHeaderComponent={
            <View>
              {/* My Code Section */}
              <Card theme="light" variant="filled" padding="lg" className="mb-6 bg-white items-center">
                <Text variant="bodySmall" color="primary" className="mb-2 opacity-50">
                  {t('profile.referral_your_code')}
                </Text>
                <Text variant="h2" color="accent" className="mb-3 tracking-widest">
                  {myCode || '...'}
                </Text>
                <Button
                  title={t('profile.referral_share')}
                  variant="primary"
                  size="md"
                  onPress={handleShare}
                  disabled={!myCode}
                />
                <Text variant="caption" color="primary" className="mt-3 text-center opacity-50">
                  {t('profile.referral_share_help', { bonus: formatCUP(bonusCup) })}
                </Text>
              </Card>

              {/* Apply Code Section */}
              {!hasBeenReferred && (
                <Card theme="light" variant="filled" padding="md" className="mb-6 bg-white">
                  <Text variant="body" color="primary" className="font-semibold mb-3">
                    {t('profile.referral_have_code')}
                  </Text>
                  <Input
                    label=""
                    placeholder={t('profile.referral_enter_code')}
                    value={inputCode}
                    onChangeText={setInputCode}
                    autoCapitalize="characters"
                    variant="light"
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
                <Card theme="light" variant="filled" padding="md" className="mb-6 bg-white">
                  <View className="flex-row items-center">
                    <Ionicons name="checkmark-circle" size={20} color="#22C55E" />
                    <Text variant="bodySmall" color="primary" className="ml-2 opacity-70">
                      {t('profile.referral_already_applied')}
                    </Text>
                  </View>
                </Card>
              )}

              {/* History header */}
              {referrals.length > 0 && (
                <Text variant="h4" color="primary" className="mb-3">
                  {t('profile.referral_history')}
                </Text>
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
