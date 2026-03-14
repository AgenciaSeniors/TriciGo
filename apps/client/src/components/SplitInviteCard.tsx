import React, { useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api';
import { formatTRC } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { colors } from '@tricigo/theme';
import type { RideSplit } from '@tricigo/types';

interface SplitInviteCardProps {
  /** Called after accepting or declining so parent can refresh */
  onAction?: () => void;
}

interface PendingInvite extends RideSplit {
  ride_pickup_address?: string;
  ride_estimated_fare_trc?: number;
  inviter_name?: string;
}

export function SplitInviteCard({ onAction }: SplitInviteCardProps) {
  const { t } = useTranslation('rider');
  const userId = useAuthStore((s) => s.user?.id);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const loadInvites = async () => {
      try {
        const data = await rideService.getMySplitInvites(userId);
        if (!cancelled) setInvites(data as PendingInvite[]);
      } catch {
        // silent — no pending invites
      }
    };

    loadInvites();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const handleAccept = async (invite: PendingInvite) => {
    if (!userId) return;
    setLoading((prev) => ({ ...prev, [invite.id]: true }));
    try {
      await rideService.acceptSplitInvite(invite.id, userId);
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      onAction?.();
    } catch {
      // keep in list on error
    } finally {
      setLoading((prev) => ({ ...prev, [invite.id]: false }));
    }
  };

  const handleDecline = async (invite: PendingInvite) => {
    setLoading((prev) => ({ ...prev, [invite.id]: true }));
    try {
      await rideService.removeSplitInvite(invite.ride_id, invite.id);
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      onAction?.();
    } catch {
      // keep in list on error
    } finally {
      setLoading((prev) => ({ ...prev, [invite.id]: false }));
    }
  };

  if (invites.length === 0) return null;

  return (
    <View className="mb-4">
      {invites.map((invite) => {
        const isProcessing = loading[invite.id] ?? false;
        const estimatedShare = invite.ride_estimated_fare_trc
          ? Math.round(invite.ride_estimated_fare_trc * invite.share_pct / 100)
          : null;

        return (
          <Card key={invite.id} variant="filled" padding="md" className="mb-2 border border-primary-200 bg-primary-50">
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
            {invite.ride_pickup_address && (
              <Text variant="caption" color="secondary" className="mb-1" numberOfLines={1}>
                📍 {invite.ride_pickup_address}
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
