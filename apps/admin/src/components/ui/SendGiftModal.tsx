'use client';

import React, { useEffect, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { getErrorMessage } from '@tricigo/utils';

type Mode = 'code' | 'phone';

interface SendGiftModalProps {
  open: boolean;
  loading?: boolean;
  /** Resolves to { toUserId, amount, note } once a recipient is found + form valid. */
  onConfirm: (args: { toUserId: string; amount: number; note: string }) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Admin "send manual gift" modal. Resolves the recipient by shareable
 * code (referral_codes) or phone via the same lookups the apps use,
 * then sends a one-sided promotional gift credit (admin_send_gift).
 * Modeled on AdjustWalletModal.
 */
export function SendGiftModal({ open, loading = false, onConfirm, onCancel }: SendGiftModalProps) {
  const { t } = useTranslation('admin');

  const [mode, setMode] = useState<Mode>('code');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [recipient, setRecipient] = useState<{ id: string; full_name: string } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [amountStr, setAmountStr] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setMode('code');
      setQuery('');
      setSearching(false);
      setRecipient(null);
      setLookupError(null);
      setAmountStr('');
      setNote('');
    }
  }, [open]);

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
    !!recipient && !isNaN(amount) && amount > 0 && amount <= 10_000_000 && note.trim().length >= 3;

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setLookupError(null);
    setRecipient(null);
    try {
      const found =
        mode === 'code'
          ? await walletService.findUserByGiftCode(q)
          : await walletService.findUserByPhone(q);
      if (!found) {
        setLookupError(t('gifts.recipient_not_found', { defaultValue: 'Usuario no encontrado' }));
        return;
      }
      setRecipient({ id: found.id, full_name: found.full_name });
    } catch (err) {
      setLookupError(getErrorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const handleConfirm = () => {
    if (!valid || loading || !recipient) return;
    void onConfirm({ toUserId: recipient.id, amount, note: note.trim() });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => !loading && onCancel()}
    >
      <div className="admin-card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('gifts.send_eyebrow', { defaultValue: 'Regalo manual' })}
          </p>
          <h3 className="font-display text-[18px] font-semibold text-ink">
            {t('gifts.send_title', { defaultValue: 'Enviar regalo a un usuario' })}
          </h3>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('gifts.send_help', { defaultValue: 'Crédito promocional. Queda en el historial de auditoría.' })}
          </p>
        </div>

        {/* Recipient lookup */}
        <div className="mt-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
            {t('gifts.recipient_label', { defaultValue: 'Destinatario' })}
          </span>
          <div className="mt-1.5 flex rounded-lg border border-line p-0.5">
            <button
              type="button"
              onClick={() => { setMode('code'); setRecipient(null); setQuery(''); }}
              className={`flex-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${mode === 'code' ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink'}`}
            >
              {t('gifts.by_code', { defaultValue: 'Código' })}
            </button>
            <button
              type="button"
              onClick={() => { setMode('phone'); setRecipient(null); setQuery(''); }}
              className={`flex-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${mode === 'phone' ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink'}`}
            >
              {t('gifts.by_phone', { defaultValue: 'Teléfono' })}
            </button>
          </div>
          <div className="mt-1.5 flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setRecipient(null); }}
              placeholder={mode === 'code' ? t('gifts.code_placeholder', { defaultValue: 'Código del usuario' }) : '+53XXXXXXXX'}
              disabled={loading}
              className="h-10 flex-1 rounded-lg border border-line bg-surface px-3 text-[14px] text-ink focus:border-primary-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSearch}
              disabled={!query.trim() || searching || loading}
              className="rounded-lg border border-line bg-surface px-4 text-[13px] font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
            >
              {searching ? t('gifts.searching', { defaultValue: 'Buscando…' }) : t('gifts.search', { defaultValue: 'Buscar' })}
            </button>
          </div>
          {lookupError && <p className="mt-1 text-[12px] text-red-500">{lookupError}</p>}
          {recipient && (
            <p className="mt-1.5 text-[13px] text-ink">
              {t('gifts.resolved_to', { defaultValue: 'Destinatario:' })}{' '}
              <span className="font-semibold">{recipient.full_name}</span>
            </p>
          )}
        </div>

        <label className="mt-4 flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
            {t('gifts.amount_label', { defaultValue: 'Monto (CUP)' })}
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={10_000_000}
            step={1}
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            placeholder="0"
            disabled={loading || !recipient}
            className="h-10 rounded-lg border border-line bg-surface px-3 text-[14px] text-ink focus:border-primary-500 focus:outline-none disabled:opacity-50"
          />
        </label>

        <label className="mt-3 flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
            {t('gifts.note_label', { defaultValue: 'Motivo (obligatorio)' })}
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('gifts.note_placeholder', { defaultValue: 'Ej: compensación por incidencia…' })}
            rows={3}
            disabled={loading}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary-500 focus:outline-none resize-none"
          />
        </label>

        <div className="mt-5 flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-lg border border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink hover:bg-surface-sunken"
          >
            {t('gifts.cancel', { defaultValue: 'Cancelar' })}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!valid || loading}
            className="rounded-lg bg-primary-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {loading ? t('gifts.sending', { defaultValue: 'Enviando…' }) : t('gifts.send_confirm', { defaultValue: 'Enviar regalo' })}
          </button>
        </div>
      </div>
    </div>
  );
}
