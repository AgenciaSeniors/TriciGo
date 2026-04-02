import React, { useState } from 'react';
import { View, Alert } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { Card } from '@tricigo/ui/Card';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api';
import { formatTRC } from '@tricigo/utils';
import { useRideStore } from '@/stores/ride.store';
import { useAuthStore } from '@/stores/auth.store';
import { darkColors } from '@tricigo/theme';
import { useThemeStore } from '@/stores/theme.store';
import type { RideSplit } from '@tricigo/types';

interface FareSplitSheetProps {
  visible: boolean;
  onClose: () => void;
  rideId: string;
  estimatedFareTrc: number;
}

export function FareSplitSheet({ visible, onClose, rideId, estimatedFareTrc }: FareSplitSheetProps) {
  const { t } = useTranslation('rider');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const userId = useAuthStore((s) => s.user?.id);
  const splits = useRideStore((s) => s.splits);
  const { addSplit, removeSplit } = useRideStore();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  // Calculate equal split percentage
  const totalParticipants = splits.length + 1; // +1 for requester
  const equalPct = Math.round(10000 / totalParticipants) / 100; // 2 decimal places
  const myShare = estimatedFareTrc - splits.reduce((sum, s) => sum + Math.round(estimatedFareTrc * s.share_pct / 100), 0);

  const handleInvite = async () => {
    if (!phone.trim() || !userId) return;
    setLoading(true);
    try {
      // Search user by phone
      const { data: users } = await (await import('@tricigo/api')).getSupabaseClient()
        .from('users')
        .select('id, raw_user_meta_data')
        .eq('phone', phone.trim())
        .limit(1);

      if (!users || users.length === 0) {
        Alert.alert('', t('ride.split_user_not_found', { defaultValue: 'Usuario no encontrado' }));
        return;
      }

      const invitedUser = users[0]!;
      if (!invitedUser?.id || !userId || invitedUser.id === userId) {
        Alert.alert('', t('ride.split_cant_invite_self', { defaultValue: 'No puedes invitarte a ti mismo' }));
        return;
      }

      // Calculate new equal share for all participants
      const newTotal = splits.length + 2; // existing splits + new invite + requester
      const newPct = Math.round(10000 / newTotal) / 100;

      const result = await rideService.createSplitInvite(rideId, invitedUser.id, userId, newPct);
      addSplit({
        ...result,
        user_name: invitedUser.raw_user_meta_data?.name ?? phone,
        user_phone: phone,
      });
      setPhone('');
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown> | null;
      if (typeof errObj?.message === 'string' && errObj.message === 'SPLIT_ONLY_TRICICOIN') {
        Alert.alert('', t('ride.split_only_tricicoin', { defaultValue: 'Dividir tarifa solo disponible con TriciCoin' }));
      } else {
        Alert.alert('', t('common.error'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (split: RideSplit) => {
    try {
      await rideService.removeSplitInvite(rideId, split.id);
      removeSplit(split.id);
    } catch {
      Alert.alert('', t('common.error'));
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text variant="h4" className="mb-4">
        {t('ride.split_fare', { defaultValue: 'Dividir tarifa' })}
      </Text>

      {/* Fare summary */}
      <Card variant="filled" padding="sm" className="mb-4">
        <View className="flex-row justify-between items-center">
          <Text variant="bodySmall" color="secondary">
            {t('ride.estimated_fare')}
          </Text>
          <Text variant="body" color="accent" className="font-bold">
            {formatTRC(estimatedFareTrc)}
          </Text>
        </View>
        <View className="flex-row justify-between items-center mt-1">
          <Text variant="bodySmall" color="secondary">
            {t('ride.split_your_share', { defaultValue: 'Tu parte' })}
          </Text>
          <Text variant="body" className="font-bold">
            ~{formatTRC(Math.round(estimatedFareTrc / totalParticipants))}
          </Text>
        </View>
      </Card>

      {/* Current participants */}
      {splits.map((split) => (
        <View key={split.id} className="flex-row items-center justify-between py-2 border-b border-neutral-100 dark:border-neutral-800">
          <View className="flex-row items-center gap-2 flex-1">
            <Ionicons name="person-circle-outline" size={28} color={isDark ? darkColors.text.secondary : '#888'} />
            <View>
              <Text variant="body">{split.user_name || split.user_phone || '...'}</Text>
              <Text variant="caption" color="secondary">
                {split.accepted_at
                  ? t('ride.split_accepted', { defaultValue: 'Aceptado' })
                  : t('ride.split_pending', { defaultValue: 'Pendiente' })
                } — {split.share_pct}%
              </Text>
            </View>
          </View>
          <Button
            title={t('ride.split_remove', { defaultValue: 'Quitar' })}
            variant="outline"
            size="sm"
            onPress={() => handleRemove(split)}
          />
        </View>
      ))}

      {/* Invite by phone */}
      <View className="mt-4">
        <Text variant="bodySmall" color="secondary" className="mb-2">
          {t('ride.split_search_user', { defaultValue: 'Buscar por teléfono' })}
        </Text>
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Input
              value={phone}
              onChangeText={setPhone}
              placeholder="+53 55555555"
              keyboardType="phone-pad"
            />
          </View>
          <Button
            title={t('ride.split_invite', { defaultValue: 'Invitar' })}
            size="md"
            onPress={handleInvite}
            loading={loading}
            disabled={!phone.trim()}
          />
        </View>
      </View>

      <View className="mt-4">
        <Button
          title={t('ride.done', { defaultValue: 'Listo' })}
          size="lg"
          fullWidth
          onPress={onClose}
        />
      </View>
    </BottomSheet>
  );
}
