// ============================================================
// TriciGo Driver — Fleet members list (Phase 4)
// Read-only list shown in the fleet owner dashboard. Each row
// shows the member name + phone + status. The status is the
// signal the owner uses to know who is still pending review,
// who has been approved by admin, and who has registered in
// the driver app already.
// ============================================================

import React from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import type { FleetMember, FleetMemberStatus } from '@tricigo/types';

interface Props {
  members: FleetMember[];
}

const STATUS_LABELS: Record<FleetMemberStatus, string> = {
  pending_review: 'Pendiente revisión',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  pending_signup: 'Esperando registro',
  active: 'Activo',
  inactive: 'Inactivo',
};

const STATUS_VARIANT: Record<FleetMemberStatus, 'success' | 'warning' | 'error' | 'info' | 'neutral'> = {
  pending_review: 'warning',
  approved: 'info',
  rejected: 'error',
  pending_signup: 'warning',
  active: 'success',
  inactive: 'neutral',
};

export default function FleetMembersList({ members }: Props) {
  if (members.length === 0) {
    return (
      <Text variant="bodySmall" color="secondary" className="text-center py-4">
        Aún no hay conductores en esta flota.
      </Text>
    );
  }

  const counts = members.reduce<Record<string, number>>((acc, m) => {
    acc[m.status] = (acc[m.status] ?? 0) + 1;
    return acc;
  }, {});

  const total = members.length;
  const active = (counts.active ?? 0) + (counts.approved ?? 0);

  return (
    <View>
      <Card variant="filled" padding="md" className="mb-3 bg-primary-50 dark:bg-primary-900/20">
        <Text variant="caption" color="secondary">Estado general</Text>
        <Text variant="h4" className="mt-1">{active} de {total} registrados</Text>
        <View className="flex-row flex-wrap gap-2 mt-2">
          {Object.entries(counts).map(([status, count]) => (
            <Text key={status} variant="caption" color="secondary">
              · {STATUS_LABELS[status as FleetMemberStatus] ?? status}: {count}
            </Text>
          ))}
        </View>
      </Card>

      {members.map((m) => (
        <View
          key={m.id}
          className="flex-row items-center justify-between py-3 border-b border-neutral-100 dark:border-neutral-800"
        >
          <View className="flex-1 mr-2">
            <Text variant="bodySmall" className="font-medium">{m.driver_name}</Text>
            <Text variant="caption" color="secondary">{m.driver_phone}</Text>
            {m.rejected_reason && (
              <Text variant="caption" color="error" className="mt-1">
                Motivo: {m.rejected_reason}
              </Text>
            )}
          </View>
          <StatusBadge label={STATUS_LABELS[m.status]} variant={STATUS_VARIANT[m.status]} />
        </View>
      ))}
    </View>
  );
}
