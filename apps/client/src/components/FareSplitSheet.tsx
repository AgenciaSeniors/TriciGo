import React, { useEffect, useState } from 'react';
import { View, Alert } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { Card } from '@tricigo/ui/Card';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';
import { rideService, walletService } from '@tricigo/api';
import { formatTRC, equalSplitSharePct, requesterShareTrc } from '@tricigo/utils';
import { useRideStore } from '@/stores/ride.store';
import { withKnownNames } from '@/stores/rideSplits';
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
  const { addSplit, removeSplit, setSplits } = useRideStore();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  // What the requester pays with the shares the server set (00613): the fare
  // minus every invitee's part, so the rounding and any withdrawn invite land here.
  const myShare = requesterShareTrc(estimatedFareTrc, splits);

  // Read the splits again each time the sheet opens: an invitee who declined
  // deleted their row, and the ride screen's realtime channel only hears
  // inserts and updates.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    rideService
      .getSplitsForRide(rideId)
      .then((fresh) => {
        if (!cancelled) setSplits(withKnownNames(fresh, useRideStore.getState().splits));
      })
      .catch(() => {
        // Keep the list the ride screen loaded.
      });
    return () => {
      cancelled = true;
    };
  }, [visible, rideId, setSplits]);

  const handleInvite = async () => {
    if (!phone.trim() || !userId) return;
    setLoading(true);
    try {
      // Search user by phone via the find_user_by_phone RPC. A direct
      // .from('users').select(...).eq('phone', …) does NOT work: public.users is
      // RLS-scoped to the caller's own row and has no raw_user_meta_data column
      // (it FKs to auth.users), so the old query 400'd / returned nothing and the
      // invite-by-phone always said "not found". The RPC is the canonical,
      // rate-limited, anti-enumeration lookup (same as the gift feature).
      let invitedUser: { id: string; full_name: string; phone: string } | null = null;
      try {
        invitedUser = await walletService.findUserByPhone(phone.trim());
      } catch {
        // Invalid phone format (cubanPhoneSchema) → treat as not found.
        invitedUser = null;
      }

      if (!invitedUser) {
        Alert.alert('', t('ride.split_user_not_found', { defaultValue: 'Usuario no encontrado' }));
        return;
      }

      if (invitedUser.id === userId) {
        Alert.alert('', t('ride.split_cant_invite_self', { defaultValue: 'No puedes invitarte a ti mismo' }));
        return;
      }

      // The server gives everyone an equal part and lowers the earlier
      // invites to it (00613); this is the share it will pick.
      const newPct = equalSplitSharePct(splits.length + 2); // + the new invitee and the requester

      const result = await rideService.createSplitInvite(rideId, invitedUser.id, userId, newPct);
      addSplit({
        ...result,
        user_name: invitedUser.full_name ?? phone,
        user_phone: phone,
      });
      setPhone('');
      // Read the shares back: the earlier invites just went down.
      try {
        const fresh = await rideService.getSplitsForRide(rideId);
        setSplits(withKnownNames(fresh, useRideStore.getState().splits));
      } catch {
        // The realtime UPDATEs bring the new shares too.
      }
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
    } catch (err) {
      // The invite is still there: keep it on the list.
      Alert.alert(
        '',
        (err as { code?: string } | null)?.code === 'SPLIT_WITHDRAW_TOO_LATE'
          ? t('ride.split_withdraw_too_late', {
              defaultValue: 'El viaje ya empezó: ya no puedes quitar a nadie de la división.',
            })
          : t('ride.split_withdraw_failed', {
              defaultValue: 'No se pudo quitar la invitación. Inténtalo de nuevo.',
            }),
      );
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
            ~{formatTRC(myShare)}
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
