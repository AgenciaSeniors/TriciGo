'use client';
import React, { useEffect, useRef, useState } from 'react';

interface AdminConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
  inputValue?: string;
  onInputChange?: (val: string) => void;
  inputPlaceholder?: string;
}

export function AdminConfirmModal({
  open, title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar',
  variant = 'default', onConfirm, onCancel, inputValue, onInputChange, inputPlaceholder
}: AdminConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Double-click guard: several money flows (reverse gift, freeze wallet,
  // reward referral) confirm through this modal and aren't idempotent. The
  // confirm button locks after the first click until the modal is reopened.
  const [confirming, setConfirming] = useState(false);

  // Escape key handler + auto-focus + reset the double-click guard
  useEffect(() => {
    if (!open) return;
    setConfirming(false);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    cancelRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open) return null;
  const btnColor = variant === 'danger' ? 'bg-red-600 hover:bg-red-700' : variant === 'warning' ? 'bg-amber-500 hover:bg-amber-600' : 'bg-primary-500 hover:bg-primary-600';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4" onClick={onCancel}>
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title" className="bg-white dark:bg-neutral-800 rounded-xl shadow-xl p-6 max-w-md w-full my-auto max-h-[90dvh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 id="confirm-modal-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">{title}</h3>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">{message}</p>
        {onInputChange && (
          <input value={inputValue} onChange={e => onInputChange(e.target.value)} placeholder={inputPlaceholder} aria-label={inputPlaceholder || 'Confirmation input'}
            className="w-full border border-neutral-300 dark:border-neutral-600 rounded-lg px-3 py-2 mb-4 text-sm bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100" />
        )}
        <div className="flex justify-end gap-3">
          <button ref={cancelRef} onClick={onCancel} className="px-4 py-2 text-sm rounded-lg border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-surface-sunken">{cancelLabel}</button>
          <button
            onClick={async () => {
              if (confirming) return;
              setConfirming(true);
              try {
                // Handlers are usually async; lock while they run and unlock
                // after they settle so a failed action can still be retried.
                await Promise.resolve(onConfirm());
              } finally {
                setConfirming(false);
              }
            }}
            disabled={confirming}
            className={`px-4 py-2 text-sm rounded-lg text-white font-medium disabled:opacity-60 disabled:cursor-not-allowed ${btnColor}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
