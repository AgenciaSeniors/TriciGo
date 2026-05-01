// ============================================================
// Wallet v2 phase 2 part B: admin-only "Send +5% bonus push" button.
// Lives in apps/admin/src/app/wallet/page.tsx header.
// Routes through admin_send_wallet_v2_bonus_push() RPC which is
// admin-gated server-side and uses get_service_role_key() to call
// the send-push EF (browser cannot expose service_role).
// ============================================================

'use client';

import { useEffect, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';

export function WalletV2BonusPushButton() {
  const { showToast } = useToast();
  const [targetCount, setTargetCount] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    adminService.getMigrationBonusTargetCount()
      .then(setTargetCount)
      .catch(() => setTargetCount(0));
  }, []);

  const handleSend = async () => {
    setSending(true);
    try {
      const result = await adminService.sendWalletV2BonusPush();
      showToast(
        'success',
        `Push enviado a ${result.pushes_dispatched} usuario${result.pushes_dispatched === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Error al enviar push',
      );
    } finally {
      setSending(false);
      setConfirmOpen(false);
    }
  };

  if (targetCount === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={sending || targetCount === null}
        className="inline-flex items-center gap-1.5 rounded-lg border border-orange-300 bg-orange-50 px-3 py-1.5 text-[12.5px] font-medium text-orange-900 transition-colors hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-orange-900/40 dark:bg-orange-950/20 dark:text-orange-200"
        title={
          targetCount != null
            ? `Enviar a ${targetCount} usuario${targetCount === 1 ? '' : 's'} con bono migración`
            : 'Cargando…'
        }
      >
        <Megaphone className="h-3.5 w-3.5" />
        {sending
          ? 'Enviando…'
          : targetCount != null
            ? `Push bono +5% (${targetCount})`
            : 'Push bono +5%'}
      </button>

      <AdminConfirmModal
        open={confirmOpen}
        title="Enviar push del bono migración"
        message={
          targetCount != null
            ? `Se enviará una notificación a ${targetCount} usuario${targetCount === 1 ? '' : 's'} que recibieron el bono del 5% durante la migración Wallet v2. Esta acción NO es idempotente: si la ejecutás otra vez, los usuarios reciben el push otra vez.`
            : 'Cargando…'
        }
        confirmLabel={sending ? 'Enviando…' : `Enviar a ${targetCount ?? '…'}`}
        cancelLabel="Cancelar"
        variant="warning"
        onConfirm={handleSend}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
