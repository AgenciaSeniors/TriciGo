/**
 * EarningsHeader — Midnight Ember edition (PR-B).
 *
 * Sub-PR E (consolidate driver wallet UI): el header ahora solo muestra
 * el título "Ganancias". Antes mostraba un BalanceBadge + botón "Ver Wallet"
 * que linkeaba al tab Wallet. Eso era redundante porque Wallet ya es un tab
 * del bottom nav y el header de Earnings no debe duplicarlo. Decisión del
 * user en sesión de planificación.
 *
 * Eliminado:
 *   - import + uso de `BalanceBadge` (también resuelve el error TS
 *     preexistente "Cannot find module '@tricigo/ui/BalanceBadge'" porque
 *     ya no se referencia desde acá; el componente sigue exportado en
 *     packages/ui para otros consumidores eventuales).
 *   - import + uso de `AnimatedCard`, `Pressable`, `Ionicons`, `router`,
 *     `useTranslation` — todo era para el botón "Ver Wallet" eliminado.
 *   - prop `balance: number` — el caller (apps/driver/app/(tabs)/earnings.tsx)
 *     ya no necesita pasar ese prop.
 */
import React from 'react';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';

export function EarningsHeader() {
  const { t } = useTranslation('driver');
  return (
    <Text
      variant="h3"
      style={{ color: midnightEmber.screen.text.primary }}
      className="mb-4"
    >
      {t('earnings.title')}
    </Text>
  );
}
