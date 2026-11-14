'use client';

/**
 * The strip on top of the assist page: who owns the ride (00681). Mine, someone else's (with a
 * "Tomar este viaje" button, after a confirmation) or nobody's, in which case the first action
 * support takes on the ride makes her the owner. The page passes `disabled` to every action while
 * someone else owns it; the server refuses those actions too (ride_owned_by_other).
 */

import { useCallback, useState } from 'react';
import { UserCheck, UserRound } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { rideAssistService, type AssistOwner } from '@tricigo/api';
import type { AssistOwnership } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { assistErrorKey } from './assistErrors';

const TONE: Record<AssistOwnership, string> = {
  mine: 'border-green-600 bg-green-500/10 text-green-800 dark:border-green-500 dark:text-green-400',
  other: 'border-amber-600 bg-amber-500/10 text-amber-800 dark:border-amber-500 dark:text-amber-400',
  none: 'border-line-strong bg-surface-sunken text-ink-muted',
};

export function AssistOwnerStrip({
  rideId,
  code,
  owner,
  ownership,
  now,
  canTake,
  onChanged,
}: {
  rideId: string;
  code: string;
  owner: AssistOwner | null;
  ownership: AssistOwnership;
  /** Date.now() ticking every second on the page. */
  now: number;
  /** The viewer may act on rides (rides.act). */
  canTake: boolean;
  /** Reloads the page. */
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const closeConfirm = useCallback(() => setConfirmOpen(false), []);

  const name = owner?.name?.trim() || '—';
  const label = owner?.on_shift === false ? t('ride_assist.chip_owner_off_shift', { name, defaultValue: '{{name}} (fuera de turno)' }) : name;
  const since = owner?.assigned_at ? Date.parse(owner.assigned_at) : NaN;
  const min = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 60_000)) : 0;

  const take = async () => {
    if (!owner) return;
    setBusy(true);
    try {
      // The owner this page showed: the server refuses with ride_changed if it moved meanwhile.
      await rideAssistService.takeRide(rideId, owner.id);
      showToast('success', t('ride_assist.owner_taken', { defaultValue: 'Ahora el viaje es tuyo.' }));
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
    } finally {
      setConfirmOpen(false);
      await Promise.resolve(onChanged()).catch(() => undefined);
      setBusy(false);
    }
  };

  const Icon = ownership === 'none' ? UserRound : UserCheck;

  return (
    <>
      <div
        role="status"
        className={`mb-6 flex flex-col gap-3 rounded-xl border-l-4 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${TONE[ownership]}`}
      >
        <p className="flex min-w-0 items-center gap-2 font-display text-[15px] font-semibold leading-snug">
          <Icon className="h-4 w-4 shrink-0" strokeWidth={2.2} aria-hidden="true" />
          <span className="min-w-0">
            {ownership === 'mine'
              ? t('ride_assist.owner_mine', { defaultValue: 'Lo atiendes tú' })
              : ownership === 'other'
                ? t('ride_assist.owner_other', { name: label, min, defaultValue: 'Lo atiende {{name}} desde hace {{min}} min' })
                : t('ride_assist.owner_none', { defaultValue: 'Sin asignar · tu primera acción te lo asigna' })}
          </span>
        </p>
        {ownership === 'other' && canTake && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
            // White on amber-700 passes AA (5.0:1), like the other warning actions of the page.
            className="min-h-[40px] shrink-0 rounded-lg bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
          >
            {t('ride_assist.owner_take', { defaultValue: 'Tomar este viaje' })}
          </button>
        )}
      </div>

      <AdminConfirmModal
        open={confirmOpen}
        title={t('ride_assist.owner_take_title', { code, defaultValue: '¿Tomar el viaje #{{code}}?' })}
        message={t('ride_assist.owner_take_message', {
          name,
          defaultValue: 'Pasará a ser tuyo y se lo avisaremos a {{name}}. Si el pasajero ya le escribió, tendrás que escribirle tú desde esta página.',
        })}
        confirmLabel={t('ride_assist.owner_take_confirm', { defaultValue: 'Tomar viaje' })}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={take}
        onCancel={closeConfirm}
      />
    </>
  );
}
