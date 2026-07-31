import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Alert, ScrollView, RefreshControl, Image } from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { useTranslation } from '@tricigo/i18n';
import { colors, darkColors } from '@tricigo/theme';
import { blockService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore } from '@/stores/theme.store';
import type { BlockedUser } from '@tricigo/types';

export default function BlockedUsersScreen() {
  const { t } = useTranslation('common');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const user = useAuthStore((s) => s.user);
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    try {
      setBlocked(await blockService.getBlockedUsers());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const handleUnblock = (item: BlockedUser) => {
    Alert.alert(
      t('block.unblock_title', { defaultValue: 'Desbloquear usuario' }),
      t('block.unblock_confirm', {
        name: item.full_name || t('block.this_user', { defaultValue: 'este usuario' }),
        defaultValue: 'Volverás a poder emparejarte con esta persona.',
      }),
      [
        { text: t('cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('block.unblock', { defaultValue: 'Desbloquear' }),
          onPress: async () => {
            try {
              await blockService.unblockUser(item.blocked_id);
              setBlocked((prev) => prev.filter((u) => u.blocked_id !== item.blocked_id));
              Toast.show({ type: 'success', text1: t('block.unblocked_ok', { defaultValue: 'Usuario desbloqueado' }) });
            } catch {
              Toast.show({ type: 'error', text1: t('errors.generic') });
            }
          },
        },
      ],
    );
  };

  if (error) {
    return <ErrorState title="Error" description={error} onRetry={() => { setError(null); setLoading(true); load(); }} />;
  }

  return (
    <Screen bg="cuban" padded>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#FF4D00" />}
      >
        <View className="pt-4">
          <ScreenHeader title={t('block.blocked_users', { defaultValue: 'Usuarios bloqueados' })} onBack={() => router.back()} />

          <Text variant="bodySmall" color="secondary" className="mb-4">
            {t('block.blocked_users_desc', { defaultValue: 'No volverás a emparejarte con las personas que bloquees.' })}
          </Text>

          {loading && blocked.length === 0 && (
            <View className="gap-3 mb-4">
              <SkeletonListItem />
              <SkeletonListItem />
            </View>
          )}

          {blocked.map((item) => (
            <Card key={item.blocked_id} variant="outlined" padding="md" className="mb-3">
              <View className="flex-row items-center">
                {item.avatar_url ? (
                  <Image
                    source={{ uri: item.avatar_url }}
                    style={{ width: 40, height: 40, borderRadius: 20, marginRight: 12 }}
                  />
                ) : (
                  <View className="w-10 h-10 rounded-full bg-primary-100 items-center justify-center mr-3">
                    <Ionicons name="person-outline" size={20} color={isDark ? colors.primary[400] : colors.primary[500]} />
                  </View>
                )}
                <View className="flex-1">
                  <Text variant="body" className="font-semibold">
                    {item.full_name || t('block.this_user', { defaultValue: 'Usuario' })}
                  </Text>
                  {item.reason ? (
                    <Text variant="caption" color="secondary" className="mt-0.5">{item.reason}</Text>
                  ) : null}
                </View>
                <Pressable
                  className="ml-2"
                  onPress={() => handleUnblock(item)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('block.unblock', { defaultValue: 'Desbloquear' })}
                >
                  <Text variant="bodySmall" className="font-semibold" style={{ color: colors.primary[500] }}>
                    {t('block.unblock', { defaultValue: 'Desbloquear' })}
                  </Text>
                </Pressable>
              </View>
            </Card>
          ))}

          {!loading && blocked.length === 0 && (
            <EmptyState
              icon="ban-outline"
              title={t('block.no_blocked', { defaultValue: 'No bloqueaste a nadie' })}
              description={t('block.no_blocked_desc', { defaultValue: 'Las personas que bloquees aparecerán aquí.' })}
            />
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
