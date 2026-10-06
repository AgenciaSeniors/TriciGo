import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api';
import { formatTRC, splitAmountTrc } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { colors } from '@tricigo/theme';
import type { SplitInvite } from '@tricigo/types';

interface SplitInviteCardProps {
  /** Called after accepting or declining so parent can refresh */
  onAction?: () => void;
}

function SplitInviteCardInner({ onAction }: SplitInviteCardProps) {
  const { t } = useTranslation('rider');
  const userId = useAuthStore((s) => s.user?.id);
  const [invites, setInvites] = useState<SplitInvite[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  // Reloads on focus and when the app comes back: the home tab stays mounted,
  // and an invite can arrive, or its ride end, while the rider is elsewhere.
  const loadInvites = useCallback(async () => {
    if (!userId) {
      setInvites([]);
      return;
    }
    try {
      setInvites(await rideService.getMySplitInvites(userId));
    } catch {
      // silent — keep what is shown
    }
  }, [userId]);
  useEffect(() => { void loadInvites(); }, [loadInvites]);
  useRefreshOnFocus(loadInvites);

  const handleAccept = async (invite: SplitInvite) => {
    if (!userId) return;
    setLoading((prev) => ({ ...prev, [invite.id]: true }));
    try {
      await rideService.acceptSplitInvite(invite.id, userId);
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      onAction?.();
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'SPLIT_INVITE_GONE') {
        // The ride ended or the requester withdrew the invite: nothing left to accept.
        setInvites((prev) => prev.filter((i) => i.id !== invite.id));
        onAction?.();
        Toast.show({
          type: 'info',
          text1: t('ride.split_invite_gone', {
            defaultValue: 'Esta invitación ya no está disponible: el viaje terminó o quien te invitó la retiró.',
          }),
        });
      } else {
        // The invite is still there: keep the card so the rider can try again.
        Toast.show({
          type: 'error',
          text1: t('ride.split_accept_failed', {
            defaultValue: 'No se pudo aceptar la invitación. Inténtalo de nuevo.',
          }),
        });
      }
    } finally {
      setLoading((prev) => ({ ...prev, [invite.id]: false }));
    }
  };

  const handleDecline = async (invite: SplitInvite) => {
    if (!userId) return;
    setLoading((prev) => ({ ...prev, [invite.id]: true }));
    try {
      await rideService.declineSplitInvite(invite.id, userId);
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      onAction?.();
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'SPLIT_ALREADY_ACCEPTED') {
        // Accepted from another device: it is no longer a pending invite.
        setInvites((prev) => prev.filter((i) => i.id !== invite.id));
        onAction?.();
        Toast.show({
          type: 'info',
          text1: t('ride.split_already_accepted', {
            defaultValue: 'Ya aceptaste esta invitación: pagarás tu parte al terminar el viaje.',
          }),
        });
      } else {
        // The invite is still there: keep the card so the rider can try again.
        Toast.show({
          type: 'error',
          text1: t('ride.split_decline_failed', {
            defaultValue: 'No se pudo rechazar la invitación. Inténtalo de nuevo.',
          }),
        });
      }
    } finally {
      setLoading((prev) => ({ ...prev, [invite.id]: false }));
    }
  };

  if (invites.length === 0) return null;

  return (
    <View className="mb-4">
      {invites.map((invite) => {
        const isProcessing = loading[invite.id] ?? false;
        const fareTrc = invite.rides?.estimated_fare_trc;
        const estimatedShare = fareTrc ? splitAmountTrc(fareTrc, invite.share_pct) : null;

        return (
          <Card key={invite.id} variant="filled" padding="md" className="mb-2 border border-primary-200 dark:border-primary-800 bg-primary-50 dark:bg-primary-900/20">
            <View className="flex-row items-center mb-2">
              <View className="w-8 h-8 rounded-full bg-primary-500 items-center justify-center mr-3">
                <Ionicons name="people" size={16} color="#fff" />
              </View>
              <View className="flex-1">
                <Text variant="body" className="font-bold">
                  {t('ride.split_invite_title', { defaultValue: 'Te invitaron a dividir' })}
                </Text>
                {invite.inviter_name && (
                  <Text variant="caption" color="secondary">
                    {t('ride.split_invited_by', { name: invite.inviter_name, defaultValue: 'Invitado por {{name}}' })}
                  </Text>
                )}
              </View>
            </View>

            {/* Ride info */}
            {invite.rides?.pickup_address && (
              <Text variant="caption" color="secondary" className="mb-1" numberOfLines={1}>
                📍 {invite.rides.pickup_address}
              </Text>
            )}

            <View className="flex-row items-center justify-between mb-3">
              <Text variant="bodySmall" color="secondary">
                {t('ride.split_your_share', { defaultValue: 'Tu parte' })}: {invite.share_pct}%
              </Text>
              {estimatedShare != null && (
                <Text variant="body" color="accent" className="font-bold">
                  ~{formatTRC(estimatedShare)}
                </Text>
              )}
            </View>

            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button
                  title={t('ride.split_decline', { defaultValue: 'Rechazar' })}
                  variant="outline"
                  size="sm"
                  fullWidth
                  onPress={() => handleDecline(invite)}
                  loading={isProcessing}
                />
              </View>
              <View className="flex-1">
                <Button
                  title={t('ride.split_accept', { defaultValue: 'Aceptar' })}
                  size="sm"
                  fullWidth
                  onPress={() => handleAccept(invite)}
                  loading={isProcessing}
                />
              </View>
            </View>
          </Card>
        );
      })}
    </View>
  );
}

export const SplitInviteCard = React.memo(SplitInviteCardInner);
