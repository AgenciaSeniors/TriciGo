// ============================================================
// TriciGo — Fleet members list
// Shown in the fleet owner dashboard. Each row shows the member name,
// phone and status, and the buttons that status allows: upload the
// licence, send the invitation again, invite again and remove. What
// each status allows lives in packages/utils/src/fleet/fleetMemberActions.ts.
// The summary counts only drivers already linked (`active`).
// ============================================================

import React, { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { fleetService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { CorporateAccountStatus, FleetInviteSend, FleetMember } from '@tricigo/types';
import {
  fleetActionFailure,
  fleetMemberActions,
  linkedMemberCount,
  type FleetActionFailure,
  type FleetMemberAction,
} from '@tricigo/utils/fleet/fleetMemberActions';
import { Text } from '../Text';
import { Card } from '../Card';
import { StatusBadge } from '../StatusBadge';
import { announce } from './announce';

/** A licence photo or PDF the owner picked on the phone. */
export interface PickedLicense {
  uri: string;
  file_name: string;
  mime_type: string;
}

/** Opens the app's file picker. Null when the owner cancelled. */
export type FleetLicensePicker = () => Promise<PickedLicense | null>;

/** Tells the owner how an action went: a toast in the app. */
export type FleetNotify = (kind: 'success' | 'info' | 'error', message: string) => void;

interface Props {
  members: FleetMember[];
  /** The invitation SMS sent for this fleet; null when the read failed. */
  sends: FleetInviteSend[] | null;
  fleetStatus: CorporateAccountStatus;
  /** Where licence files are stored: the company of the fleet. */
  corporateAccountId: string;
  onPickLicense: FleetLicensePicker;
  onNotify: FleetNotify;
  /** Something changed on the server (or the list turned out to be stale): read it again. */
  onChanged: () => void | Promise<void>;
}

// Spanish defaults of the fleet.member_status keys, for the count line.
const STATUS_LABELS: Record<string, string> = {
  pending_review: 'Pendiente revisión',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  pending_signup: 'Esperando registro',
  active: 'Activo',
  inactive: 'Inactivo',
};

// What to do after a failure, besides telling the owner: the list or the
// sends the owner saw were out of date.
const FAILURES_THAT_RELOAD: FleetActionFailure[] = ['too_soon', 'reviewed', 'not_removed'];

function ActionButton({
  label,
  accessibilityLabel,
  onPress,
  disabled,
  destructive,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled: boolean;
  destructive?: boolean;
}) {
  // The layout lives in the inner View: nothing but the hit area is in the
  // Pressable's own style.
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={{ minHeight: 44, minWidth: 44 }}
    >
      {({ pressed }) => (
        <View
          style={{
            minHeight: 44,
            minWidth: 44,
            paddingHorizontal: 12,
            justifyContent: 'center',
            alignItems: 'center',
            opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
          }}
        >
          <Text variant="label" color={destructive ? 'error' : 'accent'}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

export function FleetMembersList({
  members,
  sends,
  fleetStatus,
  corporateAccountId,
  onPickLicense,
  onNotify,
  onChanged,
}: Props) {
  const { t } = useTranslation('driver');
  const [busyId, setBusyId] = useState<string | null>(null);

  const statusLabel = (status: string) =>
    t(`fleet.member_status.${status}`, { defaultValue: STATUS_LABELS[status] ?? status });

  const failureText = (kind: FleetActionFailure): string => {
    switch (kind) {
      case 'too_soon':
        return t('fleet.error_too_soon', { defaultValue: 'Ya enviamos la invitación hace poco. Inténtalo en unas horas.' });
      case 'limit':
        return t('fleet.error_limit', { defaultValue: 'Se alcanzó el límite de reenvíos. Inténtalo más tarde.' });
      case 'invite_failed':
        return t('fleet.error_invite_failed', { defaultValue: 'No se pudo reenviar la invitación. Inténtalo de nuevo.' });
      case 'reviewed':
        return t('fleet.error_reviewed', {
          defaultValue:
            'TriciGo ya revisó a este conductor y la licencia no se puede cambiar. Quítalo e invítalo de nuevo si hace falta.',
        });
      case 'not_removed':
        return t('fleet.error_not_removed', {
          defaultValue: 'No se pudo quitar al conductor. Actualizamos la lista; inténtalo de nuevo.',
        });
      case 'exists':
        return t('fleet.add_driver_exists', { defaultValue: 'Ese teléfono ya está en tu flota.' });
      default:
        return t('fleet.error_action_failed', {
          defaultValue: 'No se pudo completar la acción. Revisa tu conexión e inténtalo de nuevo.',
        });
    }
  };

  // Runs one action on one row: one at a time per row, the outcome announced
  // to the owner, and the list read again when it changed or was stale.
  const run = async (
    member: FleetMember,
    work: () => Promise<string | null>,
    /** What an unrecognized failure says, when the action has a more specific line than the generic one. */
    otherFailureText?: string,
  ) => {
    setBusyId(member.id);
    try {
      const done = await work();
      if (done) {
        onNotify('success', done);
        announce(done);
        await onChanged();
      }
    } catch (err) {
      const kind = fleetActionFailure(err);
      const message = kind === 'failed' && otherFailureText ? otherFailureText : failureText(kind);
      onNotify('error', message);
      announce(message);
      if (FAILURES_THAT_RELOAD.includes(kind)) await onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const confirmRemove = (member: FleetMember) => {
    const body =
      member.status === 'active'
        ? t('fleet.remove_confirm_body_active', {
            defaultValue: '{{name}} dejará de recibir los viajes de tu flota.',
            name: member.driver_name,
          })
        : t('fleet.remove_confirm_body', {
            defaultValue: 'Se quitará a {{name}} de tu lista.',
            name: member.driver_name,
          });
    Alert.alert(
      t('fleet.remove_confirm_title', { defaultValue: '¿Quitar a {{name}}?', name: member.driver_name }),
      body,
      [
        { text: t('fleet.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('fleet.action.remove', { defaultValue: 'Quitar' }),
          style: 'destructive',
          onPress: () => {
            void run(member, async () => {
              await fleetService.removeMember(member.id);
              return t('fleet.removed_done', { defaultValue: 'Conductor quitado' });
            });
          },
        },
      ],
    );
  };

  const perform = (member: FleetMember, action: FleetMemberAction) => {
    switch (action) {
      case 'remove':
        confirmRemove(member);
        return;
      case 'resend':
        void run(member, async () => {
          await fleetService.resendInvite(member.id);
          return t('fleet.resend_done', { defaultValue: 'Invitación reenviada a {{name}}.', name: member.driver_name });
        });
        return;
      case 'reinvite':
        void run(member, async () => {
          await fleetService.reinviteMember(member);
          return t('fleet.reinvite_done', {
            defaultValue: '{{name}} volvió a revisión. TriciGo lo revisa de nuevo antes de invitarlo.',
            name: member.driver_name,
          });
        });
        return;
      case 'upload_license':
        void run(
          member,
          async () => {
            const picked = await onPickLicense();
            if (!picked) return null;
            await fleetService.uploadMemberLicenseFromUri({
              fleet_member_id: member.id,
              corporate_account_id: corporateAccountId,
              uri: picked.uri,
              file_name: picked.file_name,
              mime_type: picked.mime_type,
            });
            return t('fleet.license_done', { defaultValue: 'Licencia subida.' });
          },
          t('fleet.error_license_failed', {
            defaultValue: 'No se pudo subir la licencia. Revisa tu conexión e inténtalo de nuevo.',
          }),
        );
        return;
    }
  };

  const actionLabel = (action: FleetMemberAction, name: string) => {
    switch (action) {
      case 'upload_license':
        return {
          text: t('fleet.action.upload_license', { defaultValue: 'Subir licencia' }),
          a11y: t('fleet.action.upload_license_for', { defaultValue: 'Subir licencia de {{name}}', name }),
        };
      case 'resend':
        return {
          text: t('fleet.action.resend', { defaultValue: 'Reenviar' }),
          a11y: t('fleet.action.resend_for', { defaultValue: 'Reenviar invitación a {{name}}', name }),
        };
      case 'reinvite':
        return {
          text: t('fleet.action.reinvite', { defaultValue: 'Invitar de nuevo' }),
          a11y: t('fleet.action.reinvite_for', { defaultValue: 'Invitar de nuevo a {{name}}', name }),
        };
      case 'remove':
        return {
          text: t('fleet.action.remove', { defaultValue: 'Quitar' }),
          a11y: t('fleet.action.remove_for', { defaultValue: 'Quitar a {{name}}', name }),
        };
    }
  };

  if (members.length === 0) {
    return (
      <Text variant="bodySmall" color="secondary" className="text-center py-4">
        {t('fleet.members_empty', { defaultValue: 'Aún no hay conductores en esta flota.' })}
      </Text>
    );
  }

  const counts = members.reduce<Record<string, number>>((acc, m) => {
    acc[m.status] = (acc[m.status] ?? 0) + 1;
    return acc;
  }, {});

  const total = members.length;
  const linked = linkedMemberCount(members);
  const now = new Date();

  return (
    <View>
      <Card variant="filled" padding="md" className="mb-3 bg-primary-50 dark:bg-primary-900/20">
        <Text variant="caption" color="secondary">
          {t('fleet.members_overview', { defaultValue: 'Estado general' })}
        </Text>
        <Text variant="h4" className="mt-1">
          {t('fleet.members_registered', { defaultValue: '{{active}} de {{total}} vinculados', active: linked, total })}
        </Text>
        <View className="flex-row flex-wrap gap-2 mt-2">
          {Object.entries(counts).map(([status, count]) => (
            <Text key={status} variant="caption" color="secondary">
              · {statusLabel(status)}: {count}
            </Text>
          ))}
        </View>
      </Card>

      {members.map((m) => {
        const { label, actions } = fleetMemberActions(m, sends, fleetStatus, now);
        const busy = busyId === m.id;
        return (
          <View key={m.id} className="py-3 border-b border-neutral-100 dark:border-neutral-800">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-2">
                <Text variant="bodySmall" className="font-medium">{m.driver_name}</Text>
                <Text variant="caption" color="secondary">{m.driver_phone}</Text>
                {m.rejected_reason && (
                  <Text variant="caption" color="error" className="mt-1">
                    {t('fleet.rejected_reason', { defaultValue: 'Motivo: {{reason}}', reason: m.rejected_reason })}
                  </Text>
                )}
                {m.status === 'pending_review' && m.license_doc_path && (
                  <Text variant="caption" color="secondary" className="mt-1">
                    {t('fleet.license_attached', { defaultValue: 'Licencia adjunta' })}
                  </Text>
                )}
              </View>
              <StatusBadge label={t(label.labelKey, { defaultValue: label.label })} variant={label.variant} />
            </View>
            <View className="flex-row flex-wrap items-center mt-1">
              {actions.map((action) => {
                const text = actionLabel(action, m.driver_name);
                return (
                  <ActionButton
                    key={action}
                    label={text.text}
                    accessibilityLabel={text.a11y}
                    destructive={action === 'remove'}
                    disabled={busy}
                    onPress={() => perform(m, action)}
                  />
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}
