import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Alert, ScrollView, RefreshControl, Image, useColorScheme, ActivityIndicator } from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { useTranslation } from '@tricigo/i18n';
import { cubanLight, cubanDark, colors } from '@tricigo/theme';
import { blockService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import type { BlockedUser } from '@tricigo/types';

export default function BlockedUsersScreen() {
  const { t } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
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
    <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }} className="pt-4 px-5">
        <ScreenHeader
          title={t('block.blocked_users', { defaultValue: 'Usuarios bloqueados' })}
          onBack={() => router.back()}
        />

        <Text style={{ fontSize: 13, color: palette.ink.secondary, marginTop: 8, marginBottom: 12 }}>
          {t('block.blocked_users_desc', { defaultValue: 'No volverás a emparejarte con las personas que bloquees.' })}
        </Text>

        {loading && blocked.length === 0 ? (
          <View className="items-center py-12">
            <ActivityIndicator color={colors.brand.orange} />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{ paddingBottom: 24 }}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.brand.orange} />}
          >
            {blocked.map((item) => (
              <View
                key={item.blocked_id}
                style={{ backgroundColor: palette.bg.elev1, borderRadius: 14, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center' }}
              >
                {item.avatar_url ? (
                  <Image source={{ uri: item.avatar_url }} style={{ width: 40, height: 40, borderRadius: 20, marginRight: 12 }} />
                ) : (
                  <View style={{ width: 40, height: 40, borderRadius: 20, marginRight: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.bg.elev2 }}>
                    <Ionicons name="person-outline" size={20} color={palette.ink.subtle} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: palette.ink.primary }}>
                    {item.full_name || t('block.this_user', { defaultValue: 'Usuario' })}
                  </Text>
                  {item.reason ? (
                    <Text style={{ fontSize: 12, color: palette.ink.subtle, marginTop: 2 }}>{item.reason}</Text>
                  ) : null}
                </View>
                <Pressable
                  onPress={() => handleUnblock(item)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('block.unblock', { defaultValue: 'Desbloquear' })}
                >
                  <Text style={{ fontSize: 13, fontWeight: '600', color: colors.brand.orange }}>
                    {t('block.unblock', { defaultValue: 'Desbloquear' })}
                  </Text>
                </Pressable>
              </View>
            ))}

            {!loading && blocked.length === 0 && (
              <View className="items-center py-12">
                <Ionicons name="ban-outline" size={40} color={palette.ink.subtle} />
                <Text style={{ color: palette.ink.primary, fontWeight: '600', marginTop: 12 }}>
                  {t('block.no_blocked', { defaultValue: 'No bloqueaste a nadie' })}
                </Text>
                <Text style={{ color: palette.ink.subtle, fontSize: 13, marginTop: 4, textAlign: 'center' }}>
                  {t('block.no_blocked_desc', { defaultValue: 'Las personas que bloquees aparecerán acá.' })}
                </Text>
              </View>
            )}
          </ScrollView>
        )}
      </View>
    </Screen>
  );
}
