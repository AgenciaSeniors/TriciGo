import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { isProposalGone, rideAssistService, type ServiceProposal } from '@tricigo/api';
import { formatCUP, formatTRC } from '@tricigo/utils';

interface ServiceProposalCardProps {
  proposal: ServiceProposal;
  /** 'tricicoin' shows TRC, anything else CUP, like the rest of SearchingView. */
  paymentMethod: string | null | undefined;
  sharedRide: boolean;
  /** The card should go: answered, or no longer acceptable. `accepted` says whether the type changed. */
  onDone: (accepted: boolean) => void;
}

/**
 * Whole seconds left on the proposal. Counts down the server's own `expires_in_s` from the moment
 * the answer arrived, so a phone whose clock is minutes off still shows the full window; against a
 * server that predates `expires_in_s` it falls back to `expires_at` on the phone's clock.
 */
function secondsLeft(proposal: ServiceProposal, nowMs: number): number {
  if (typeof proposal.expires_in_s === 'number' && Number.isFinite(proposal.expires_in_s)) {
    // The 1 s tick can lag a fresh answer; never count a negative elapsed time.
    const elapsedMs = Math.max(0, nowMs - proposal.received_at_ms);
    return Math.floor(proposal.expires_in_s - elapsedMs / 1000);
  }
  return Math.floor((new Date(proposal.expires_at).getTime() - nowMs) / 1000);
}

/**
 * Support proposes switching the searching ride to another vehicle type at a new price (00628,
 * admin_change_ride_service). Accepting switches it at once and the search goes on with drivers
 * of the new type; rejecting it, or letting it expire, changes nothing.
 */
export function ServiceProposalCard({ proposal, paymentMethod, sharedRide, onDone }: ServiceProposalCardProps) {
  const { t } = useTranslation('rider');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const left = Math.max(0, secondsLeft(proposal, now));
  // Past expiry the server refuses it anyway; the next poll clears it.
  if (left === 0) return null;

  const money = (n: number) => (paymentMethod === 'tricicoin' ? formatTRC(n) : formatCUP(n));
  const typeName = (slug: string) => t(`service_type.${slug}`, { defaultValue: slug });
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  const respond = async (accept: boolean) => {
    setBusy(true);
    try {
      await rideAssistService.respondProposal(proposal.id, accept);
      if (accept) {
        Toast.show({
          type: 'success',
          text1: t('home.support_proposal_accepted', { type: typeName(proposal.to_service_type) }),
        });
      }
      onDone(accept);
    } catch (err) {
      if (isProposalGone(err)) {
        Toast.show({ type: 'info', text1: t('home.support_proposal_gone') });
        onDone(false);
      } else {
        Toast.show({ type: 'error', text1: t('home.support_proposal_failed') });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      variant="filled"
      padding="md"
      className="border border-primary-200 dark:border-primary-800 bg-primary-50 dark:bg-primary-900/20"
    >
      <View className="flex-row items-center mb-2">
        <View className="w-8 h-8 rounded-full bg-primary-500 items-center justify-center mr-3">
          <Ionicons name="swap-horizontal" size={16} color="#fff" />
        </View>
        <Text variant="body" className="flex-1 font-bold">
          {t('home.support_proposal_title')}
        </Text>
      </View>
      <Text variant="body" className="font-bold mb-1">
        {t('home.support_proposal_body', {
          type: typeName(proposal.to_service_type),
          price: money(proposal.to_fare_cup),
        })}
      </Text>
      <Text variant="caption" color="secondary" className="mb-1">
        {t('home.support_proposal_before', {
          type: typeName(proposal.from_service_type),
          price: money(proposal.from_fare_cup),
        })}
      </Text>
      {sharedRide && proposal.to_service_type !== 'triciclo_basico' && (
        <Text variant="caption" color="secondary" className="mb-1">
          {t('home.support_proposal_shared_note')}
        </Text>
      )}
      <Text variant="caption" color="tertiary" className="mb-3">
        {t('home.support_proposal_expires', { time: clock })}
      </Text>
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button
            title={t('home.support_proposal_reject')}
            variant="outline"
            size="sm"
            fullWidth
            onPress={() => void respond(false)}
            loading={busy}
          />
        </View>
        <View className="flex-1">
          <Button
            title={t('home.support_proposal_accept')}
            size="sm"
            fullWidth
            onPress={() => void respond(true)}
            loading={busy}
          />
        </View>
      </View>
    </Card>
  );
}
