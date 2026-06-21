/**
 * RecentActivitySection — Midnight Ember edition (PR-B).
 *
 * Collapsible card listing recent driver wallet transactions.
 *
 * v2 tokenization:
 *   - Card surface: `screen.bg.surface` + `line.default` + `radius.card`
 *     + `shadow.card`.
 *   - Tx list separator: `screen.line.hairline`.
 *   - Header icon + "Ver mas" link: `accent[500]`.
 *   - Tx amount + icon: `state.success` (credit) / `state.danger`
 *     (debit). The single source of truth replaces three independent
 *     hex literals (`#22C55E` and `#EF4444` repeated).
 *   - Header chevron + secondary labels via `screen.text.*`.
 */
import React, { useState, useEffect } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP, classifyWalletTxn, walletTxnIcon } from '@tricigo/utils';
import { midnightEmber } from '@tricigo/theme';
import type { LedgerTransaction } from '@tricigo/types';

export type TransactionWithAmount = LedgerTransaction & {
  ledger_entries: { account_id: string; amount: number }[];
};

interface RecentActivitySectionProps {
  transactions: TransactionWithAmount[];
  /** Driver's wallet account id — sum entries for THIS account (a mixed-ride
   *  txn credits the wallet portion AND debits commission; reading entry[0]
   *  would show the gross wallet portion instead of the net). */
  accountId?: string | null;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onExpandedChange?: (expanded: boolean) => void;
}

/** Driver-namespace label from the shared classifier kind. Mirrors the wallet
 *  screen; the bug-prone classification (gift direction, tip detection) lives in
 *  @tricigo/utils so the two driver surfaces stay in sync. */
function driverTxLabel(
  view: { kind: string; isCredit: boolean },
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (view.kind) {
    case 'recharge': return t('earnings.tx_recharge', { defaultValue: 'Recarga' });
    case 'ride':
      return view.isCredit
        ? t('earnings.tx_ride_earning', { defaultValue: 'Ingreso por viaje' })
        : t('earnings.tx_ride_payment', { defaultValue: 'Pago de viaje' });
    case 'commission': return t('earnings.tx_commission', { defaultValue: 'Comisión' });
    case 'gift':
    case 'transfer':
      return view.isCredit
        ? t('earnings.tx_gift_received', { defaultValue: 'Regalo recibido' })
        : t('earnings.tx_gift_sent', { defaultValue: 'Regalo enviado' });
    case 'tip':
      return view.isCredit
        ? t('earnings.tx_tip_received', { defaultValue: 'Propina recibida' })
        : t('earnings.tx_tip_sent', { defaultValue: 'Propina enviada' });
    case 'penalty': return t('earnings.tx_penalty', { defaultValue: 'Penalización' });
    case 'bonus': return t('earnings.tx_bonus', { defaultValue: 'Bono' });
    case 'refund': return t('earnings.tx_refund', { defaultValue: 'Reembolso' });
    case 'fx': return t('earnings.tx_fx', { defaultValue: 'Ajuste por tipo de cambio' });
    case 'adjustment':
    default: return t('earnings.tx_adjustment', { defaultValue: 'Ajuste' });
  }
}

export function RecentActivitySection({
  transactions,
  accountId,
  loading,
  hasMore,
  onLoadMore,
  onExpandedChange,
}: RecentActivitySectionProps) {
  const { t } = useTranslation('driver');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  return (
    <View className="mt-8 mb-4">
      <Card
        variant="filled"
        padding="md"
        style={{
          backgroundColor: midnightEmber.screen.bg.surface,
          borderWidth: 1,
          borderColor: midnightEmber.screen.line.default,
          borderRadius: midnightEmber.radius.card,
          ...midnightEmber.shadow.card,
        }}
      >
        <Pressable
          onPress={() => setExpanded((p) => !p)}
          className="flex-row items-center justify-between min-h-[48px]"
          accessibilityRole="button"
          accessibilityLabel={t('earnings.recent_activity', { defaultValue: 'Movimientos' })}
          accessibilityState={{ expanded }}
        >
          <View className="flex-row items-center">
            <Ionicons
              name="receipt-outline"
              size={18}
              color={midnightEmber.accent[500]}
            />
            <Text
              variant="body"
              className="font-semibold"
              style={{ color: midnightEmber.screen.text.primary, marginLeft: 8 }}
            >
              {t('earnings.recent_activity', { defaultValue: 'Movimientos' })}
            </Text>
          </View>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={midnightEmber.screen.text.secondary}
          />
        </Pressable>

        {expanded && (
          <View className="mt-3">
            {transactions.length === 0 && !loading && (
              <Text
                variant="bodySmall"
                className="text-center py-4"
                style={{ color: midnightEmber.screen.text.secondary }}
              >
                {t('earnings.no_transactions', { defaultValue: 'No hay transacciones recientes' })}
              </Text>
            )}
            {transactions.map((tx) => {
              const view = classifyWalletTxn(tx, accountId);
              const amount = view.signedAmount;
              const isCredit = view.isCredit;
              const txColor = isCredit
                ? midnightEmber.state.success
                : midnightEmber.state.danger;
              const iconName = walletTxnIcon(view) as keyof typeof Ionicons.glyphMap;
              return (
                <View
                  key={tx.id}
                  className="flex-row items-center py-2"
                  style={{
                    borderBottomWidth: 1,
                    borderBottomColor: midnightEmber.screen.line.hairline,
                  }}
                >
                  <Ionicons name={iconName} size={16} color={txColor} />
                  <View className="flex-1 ml-2">
                    <Text
                      variant="bodySmall"
                      style={{ color: midnightEmber.screen.text.primary }}
                    >
                      {driverTxLabel(view, t)}
                    </Text>
                    <Text
                      variant="badge"
                      style={{ color: midnightEmber.screen.text.secondary }}
                    >
                      {new Date(tx.created_at).toLocaleDateString('es', { timeZone: 'America/Havana' })}
                    </Text>
                  </View>
                  <Text
                    variant="bodySmall"
                    style={{ color: txColor, fontWeight: '600' }}
                  >
                    {view.isZero ? '' : isCredit ? '+' : '−'}{formatCUP(Math.abs(amount))}
                  </Text>
                </View>
              );
            })}
            {hasMore && transactions.length > 0 && (
              <Pressable
                onPress={onLoadMore}
                className="py-3 items-center min-h-[48px] justify-center"
                accessibilityRole="button"
                accessibilityLabel={t('earnings.view_more', { defaultValue: 'Ver mas' })}
              >
                <Text
                  variant="bodySmall"
                  style={{ color: midnightEmber.accent[500] }}
                >
                  {loading ? '...' : t('earnings.view_more', { defaultValue: 'Ver mas' })}
                </Text>
              </Pressable>
            )}
            {loading && transactions.length === 0 && (
              <ActivityIndicator
                size="small"
                color={midnightEmber.accent[500]}
                className="py-4"
              />
            )}
          </View>
        )}
      </Card>
    </View>
  );
}
