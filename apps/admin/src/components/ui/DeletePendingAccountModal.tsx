'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@tricigo/api';
import type { PendingAccountDeletability } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { getErrorMessage } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';

function formatCurrency(amount: number): string {
  return `${Math.round(amount).toLocaleString('es-CU')} TRC`;
}

interface DeletePendingAccountModalProps {
  open: boolean;
  /** users.id of the account to delete (for a driver, driver_profiles.user_id) */
  userId: string;
  /** Display name shown in the summary */
  userName: string;
  onClose: () => void;
  /** Called after a successful deletion — parent decides navigation. */
  onDeleted: () => void;
}

/**
 * Shared "Eliminar cuenta pendiente" flow. Runs the server-side dry-run check
 * (blockers) when it opens, shows the account summary, and only enables the
 * confirm button when the account is safe to delete. Reused by the user detail
 * page and the driver detail page's Acciones menu. All the real gating lives in
 * the `admin-delete-pending-account` Edge Function — this is just the UI.
 */
export function DeletePendingAccountModal({
  open,
  userId,
  userName,
  onClose,
  onDeleted,
}: DeletePendingAccountModalProps) {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [checking, setChecking] = useState(false);
  const [deletability, setDeletability] = useState<PendingAccountDeletability | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    setDeletability(null);
    setReason('');
    setChecking(true);
    (async () => {
      try {
        const result = await adminService.checkPendingAccountDeletable(userId);
        if (!cancelled) setDeletability(result);
      } catch (err) {
        if (!cancelled) {
          showToast('error', getErrorMessage(err));
          onClose();
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId]);

  if (!open) return null;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await adminService.deletePendingAccount(userId, reason || undefined);
      showToast('success', t('users.delete_account_success'));
      onDeleted();
    } catch (err) {
      // The server re-checks the safety gate; surface its blockers if it refused.
      const blockers = (err as { blockers?: string[] }).blockers;
      if (blockers?.length) {
        setDeletability((prev) => (prev ? { ...prev, deletable: false, blockers } : prev));
      } else {
        showToast('error', getErrorMessage(err));
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="delete-account-title" className="bg-surface-elevated rounded-xl p-6 w-full max-w-md my-auto max-h-[90dvh] overflow-y-auto">
        <h3 id="delete-account-title" className="text-lg font-bold mb-2">{t('users.delete_account_title')}</h3>
        <p className="text-sm text-ink-muted mb-4">{t('users.delete_account_desc')}</p>

        {checking ? (
          <p className="text-sm text-ink-subtle py-4">{t('users.delete_account_checking')}</p>
        ) : deletability ? (
          <div className="mb-4">
            <div className="bg-surface-sunken rounded-lg p-3 mb-3 space-y-1">
              <p className="text-sm font-medium">{userName}</p>
              <p className="text-xs text-ink-muted">
                {t('users.delete_account_summary_rides', {
                  customer: deletability.summary.rides_as_customer,
                  driver: deletability.summary.rides_as_driver,
                })}
              </p>
              <p className="text-xs text-ink-muted">
                {t('users.delete_account_summary_balance', {
                  balance: formatCurrency(deletability.summary.wallet_balance_total),
                })}
              </p>
            </div>
            {deletability.deletable ? (
              <p className="text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">
                {t('users.delete_account_deletable')}
              </p>
            ) : (
              <div className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">
                <p className="font-medium mb-1">{t('users.delete_account_not_deletable')}</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {deletability.blockers.map((b) => (
                    <li key={b}>{t(`users.delete_blocker_${b}`, { defaultValue: b })}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : null}

        {deletability?.deletable && (
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('users.delete_account_reason_ph')}
            aria-label={t('users.delete_account_reason_ph')}
            className="w-full border border-line bg-surface text-ink rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:border-primary-500"
          />
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            disabled={deleting}
            className="px-4 py-2 rounded-lg text-sm font-medium text-ink-muted hover:bg-surface-sunken transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          {deletability?.deletable && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {deleting ? t('common.processing') : t('users.delete_account_confirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
