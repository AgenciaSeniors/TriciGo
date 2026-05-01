'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';

// Mirror the wallet_account_type Postgres enum (see
// supabase/migrations/00001_initial_schema.sql + 00094_trc_rebase). The
// modal only renders toggles for the 2 cash variants today, but other
// account types (notably 'tricicoin' for driver_quota / TC top-ups) are
// still valid `defaultAccountType` values passed by callers like
// drivers/[id]/page.tsx — without listing them here the build crashes
// with "Type '"tricicoin"' is not assignable to type WalletAccountType".
export type WalletAccountType =
  | 'customer_cash'
  | 'driver_cash'
  | 'driver_hold'
  | 'driver_quota'
  | 'platform_revenue'
  | 'platform_promotions'
  | 'corporate_cash'
  | 'tricicoin';

interface AdjustWalletModalProps {
  open: boolean;
  /** Target user's display name (shown in header) */
  userName: string;
  /** If true, user is a driver — show toggle between customer_cash and driver_cash */
  isDriver?: boolean;
  /** Default account type. Defaults to 'customer_cash' for riders, 'driver_cash' for drivers */
  defaultAccountType?: WalletAccountType;
  loading?: boolean;
  onConfirm: (args: {
    accountType: WalletAccountType;
    amountCup: number;
    reason: string;
  }) => void | Promise<void>;
  onCancel: () => void;
}

export function AdjustWalletModal({
  open,
  userName,
  isDriver = false,
  defaultAccountType,
  loading = false,
  onConfirm,
  onCancel,
}: AdjustWalletModalProps) {
  const { t } = useTranslation('admin');

  const [accountType, setAccountType] = useState<WalletAccountType>(
    defaultAccountType ?? (isDriver ? 'driver_cash' : 'customer_cash'),
  );
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [amountStr, setAmountStr] = useState('');
  const [reason, setReason] = useState('');

  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setAccountType(defaultAccountType ?? (isDriver ? 'driver_cash' : 'customer_cash'));
      setDirection('credit');
      setAmountStr('');
      setReason('');
      setTimeout(() => amountRef.current?.focus(), 50);
    }
  }, [open, defaultAccountType, isDriver]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onCancel, loading]);

  if (!open) return null;

  const amount = parseInt(amountStr, 10);
  const valid =
    !isNaN(amount) &&
    amount > 0 &&
    amount <= 10_000_000 &&
    reason.trim().length >= 3;

  const signedAmount = direction === 'credit' ? amount : -amount;

  const handleConfirm = () => {
    if (!valid || loading) return;
    void onConfirm({
      accountType,
      amountCup: signedAmount,
      reason: reason.trim(),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => !loading && onCancel()}
    >
      <div
        className="admin-card w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('admin_ops.adjust_wallet_eyebrow', { defaultValue: 'Operación financiera' })}
          </p>
          <h3 className="font-display text-[18px] font-semibold text-ink">
            {t('admin_ops.adjust_wallet_title', { defaultValue: 'Ajustar saldo TriciCoin' })}
          </h3>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('admin_ops.adjust_wallet_target', {
              defaultValue: `Usuario: ${userName}`,
              userName,
            })}
          </p>
        </div>

        {isDriver && (
          <div className="mt-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              {t('admin_ops.account_type_label', { defaultValue: 'Cuenta' })}
            </span>
            <div className="mt-1.5 flex rounded-lg border border-line p-0.5">
              <button
                type="button"
                onClick={() => setAccountType('customer_cash')}
                className={`flex-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                  accountType === 'customer_cash'
                    ? 'bg-ink text-surface'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                {t('admin_ops.account_customer', { defaultValue: 'Pasajero (wallet)' })}
              </button>
              <button
                type="button"
                onClick={() => setAccountType('driver_cash')}
                className={`flex-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                  accountType === 'driver_cash'
                    ? 'bg-ink text-surface'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                {t('admin_ops.account_driver', { defaultValue: 'Conductor (cuota)' })}
              </button>
            </div>
          </div>
        )}

        <div className="mt-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
            {t('admin_ops.direction_label', { defaultValue: 'Operación' })}
          </span>
          <div className="mt-1.5 flex rounded-lg border border-line p-0.5">
            <button
              type="button"
              onClick={() => setDirection('credit')}
              className={`flex-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                direction === 'credit'
                  ? 'bg-emerald-500 text-white'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              {t('admin_ops.direction_credit', { defaultValue: '+ Agregar' })}
            </button>
            <button
              type="button"
              onClick={() => setDirection('debit')}
              className={`flex-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                direction === 'debit'
                  ? 'bg-red-500 text-white'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              {t('admin_ops.direction_debit', { defaultValue: '− Quitar' })}
            </button>
          </div>
        </div>

        <label className="mt-4 flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
            {t('admin_ops.amount_label', { defaultValue: 'Monto (CUP)' })}
          </span>
          <input
            ref={amountRef}
            type="number"
            inputMode="numeric"
            min={1}
            max={10_000_000}
            step={1}
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            placeholder="0"
            disabled={loading}
            className="h-10 rounded-lg border border-line bg-surface px-3 text-[14px] text-ink focus:border-primary-500 focus:outline-none"
          />
        </label>

        <label className="mt-3 flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
            {t('admin_ops.reason_label', { defaultValue: 'Razón (obligatorio)' })}
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('admin_ops.reason_placeholder', {
              defaultValue: 'Explicá por qué se hace este ajuste…',
            })}
            rows={3}
            disabled={loading}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary-500 focus:outline-none resize-none"
          />
          <span className="text-[11px] text-ink-subtle">
            {t('admin_ops.reason_hint', {
              defaultValue: 'Este mensaje queda en el historial de auditoría y se envía al email business.',
            })}
          </span>
        </label>

        {valid && (
          <div className="mt-3 rounded-lg border border-line bg-surface-sunken/50 p-3">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
              {t('admin_ops.preview', { defaultValue: 'Vista previa' })}
            </p>
            <p className="mt-1 text-[13px] text-ink">
              {direction === 'credit' ? '+' : '−'}
              <span className="font-mono">{amount.toLocaleString()}</span>
              <span className="ml-1 text-ink-muted">CUP</span>
              <span className="mx-2 text-ink-subtle">→</span>
              <span className="text-ink-muted">
                {accountType === 'driver_cash'
                  ? t('admin_ops.account_driver', { defaultValue: 'Cuota conductor' })
                  : t('admin_ops.account_customer', { defaultValue: 'Wallet pasajero' })}
              </span>
            </p>
          </div>
        )}

        <div className="mt-5 flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-lg border border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink hover:bg-surface-sunken"
          >
            {t('admin_ops.cancel', { defaultValue: 'Cancelar' })}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!valid || loading}
            className={`rounded-lg px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50 ${
              direction === 'credit' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {loading
              ? t('admin_ops.applying', { defaultValue: 'Aplicando…' })
              : t('admin_ops.confirm', { defaultValue: 'Confirmar ajuste' })}
          </button>
        </div>
      </div>
    </div>
  );
}
