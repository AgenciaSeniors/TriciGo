'use client';

/**
 * The "En turno" switch in the header, for ops staff (00679). Whoever is on shift owns the rides
 * that ask for support, and riders and drivers write to her WhatsApp. It starts off; turning it on
 * the first time asks for the number (prefilled from her account phone). The chevron next to it
 * opens who else is on shift and lets her change the number. The status is polled every 30 s so an
 * automatic off-shift (she left rides unopened) shows up.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import {
  AppError,
  RIDE_ASSIST_UNAVAILABLE,
  supportShiftService,
  type SupportShiftChange,
  type SupportShiftStatus,
} from '@tricigo/api';
import { normalizeSupportWhatsapp } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { assistErrorKey } from './assistErrors';

const POLL_MS = 30_000;

export function SupportShiftSwitch() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [status, setStatus] = useState<SupportShiftStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<'on' | 'change' | null>(null);
  const [number, setNumber] = useState('');
  const [numberError, setNumberError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  // The last on_shift the server told us, and whether this tab caused the latest change: a switch
  // that turns off on its own (missed rides in a row) is told to her; her own click is not.
  const lastOnRef = useRef<boolean | null>(null);
  const ownChangeRef = useRef(false);

  // Only the newest read may write: a poll that read the status before setShift committed can
  // answer after it, and would show the old state (or a false "auto off-shift" warning).
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latestLoad.current;
    try {
      const next = await supportShiftService.getStatus();
      if (!mountedRef.current || seq !== latestLoad.current) return;
      const on = next.me?.on_shift ?? false;
      // ownChangeRef stays set while this tab's own change is in flight (apply clears it).
      if (lastOnRef.current === true && !on && !ownChangeRef.current) {
        showToast('warning', t('ride_assist.shift_auto_off', {
          defaultValue: 'Te sacamos de turno: no abriste viajes seguidos. Actívalo de nuevo cuando puedas.',
        }), 12_000);
      }
      lastOnRef.current = on;
      setStatus(next);
    } catch (err) {
      // Keep what is shown; the next poll retries. A server without 00679 has no switch at all.
      if (mountedRef.current && err instanceof AppError && err.code === RIDE_ASSIST_UNAVAILABLE) setUnavailable(true);
    }
  }, [showToast, t]);

  useEffect(() => {
    mountedRef.current = true;
    if (unavailable) return;
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [load, unavailable]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menuOpen]);

  const me = status?.me ?? null;
  const on = me?.on_shift ?? false;
  const others = status?.on_shift ?? [];

  const tellResult = (r: SupportShiftChange, turnedOn: boolean) => {
    if (turnedOn) {
      showToast(
        'success',
        r.picked_up > 0
          ? t('ride_assist.shift_picked_up', {
              count: r.picked_up,
              defaultValue_one: '{{count}} viaje te fue asignado',
              defaultValue_other: '{{count}} viajes te fueron asignados',
            })
          : t('ride_assist.shift_on_done', { defaultValue: 'Estás en turno.' }),
      );
      return;
    }
    const parts: string[] = [];
    if (r.handed_over > 0) {
      const name = others.map((o) => o.name).join(', ') || '—';
      parts.push(
        t('ride_assist.shift_handed', {
          count: r.handed_over,
          name,
          defaultValue_one: '{{count}} viaje pasó a {{name}}',
          defaultValue_other: '{{count}} viajes pasaron a {{name}}',
        }),
      );
    }
    if (r.kept > 0) {
      parts.push(
        t('ride_assist.shift_kept', {
          count: r.kept,
          defaultValue_one: 'Tu viaje sigue contigo: no hay nadie más en turno',
          defaultValue_other: 'Tus {{count}} viajes siguen contigo: no hay nadie más en turno',
        }),
      );
    }
    showToast('success', parts.length > 0 ? parts.join(' ') : t('ride_assist.shift_off_done', { defaultValue: 'Saliste de turno.' }), 8_000);
  };

  /** Returns whether the server accepted it, so the number dialog knows to close. */
  const apply = async (turnOn: boolean, whatsapp?: string, numberOnly = false): Promise<boolean> => {
    setBusy(true);
    ownChangeRef.current = true;
    // Drop any poll already in flight: it read the state from before this change.
    latestLoad.current++;
    try {
      const r = await supportShiftService.setShift(turnOn, whatsapp);
      // Changing the number only stores it (the server returns 0/0/0): no on/off messages.
      if (numberOnly) showToast('success', t('ride_assist.shift_number_updated', { defaultValue: 'Número guardado.' }));
      else tellResult(r, turnOn);
      return true;
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
      return false;
    } finally {
      await load();
      ownChangeRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const openDialog = (mode: 'on' | 'change') => {
    setNumber(me?.whatsapp_phone ?? status?.suggested_whatsapp ?? '');
    setNumberError(null);
    setMenuOpen(false);
    setDialog(mode);
  };

  const toggle = () => {
    if (busy || !status) return;
    if (on) void apply(false);
    else if (!me?.whatsapp_phone) openDialog('on');
    else void apply(true);
  };

  const closeDialog = useCallback(() => setDialog(null), []);

  const confirmNumber = async () => {
    const normalized = normalizeSupportWhatsapp(number);
    if (!normalized) {
      setNumberError(t('ride_assist.error_invalid_whatsapp', {
        defaultValue: 'Ese número no es válido. Escríbelo con código de país, por ejemplo +53 51234567.',
      }));
      return;
    }
    const mode = dialog;
    // Changing the number keeps the switch as it is; the first time on turns it on.
    const ok = await apply(mode === 'change' ? on : true, normalized, mode === 'change');
    if (ok) setDialog(null);
  };

  // Not deployed yet, or not read yet: no switch rather than one that cannot work.
  if (unavailable || !status) return null;

  return (
    // Not positioned below sm: the popover then anchors to the (sticky, full-width) header.
    <div ref={rootRef} className="sm:relative">
      <div
        className={`flex h-9 items-center rounded-full border transition-colors ${
          on ? 'border-green-600/50 bg-green-500/10' : 'border-line bg-surface'
        }`}
      >
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t('ride_assist.shift_switch_aria', { defaultValue: 'Estar en turno de soporte' })}
          disabled={busy}
          onClick={toggle}
          className="flex h-9 items-center gap-2 rounded-l-full pl-2 pr-1.5 disabled:opacity-60 sm:pr-2"
        >
          <span
            aria-hidden="true"
            className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors ${
              on ? 'bg-green-600' : 'bg-line-strong'
            }`}
          >
            {/* eslint-disable-next-line tricigo/require-dark-variant -- the knob is white on both track colors, in both themes */}
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
          </span>
          <span className={`hidden text-[12px] font-semibold sm:inline ${on ? 'text-green-700 dark:text-green-400' : 'text-ink-muted'}`}>
            {t('ride_assist.shift_label', { defaultValue: 'En turno' })}
          </span>
        </button>
        <button
          type="button"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          aria-label={t('ride_assist.shift_details_aria', { defaultValue: 'Detalles del turno' })}
          onClick={() => {
            setMenuOpen((v) => !v);
            if (!menuOpen) void load();
          }}
          className="relative flex h-9 w-7 items-center justify-center rounded-r-full text-ink-muted hover:text-ink"
        >
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          {others.length > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-primary-700 px-1 text-[9px] font-bold leading-none text-white">
              {others.length}
            </span>
          )}
        </button>
      </div>

      {menuOpen && (
        // Phones: 12 px inside both edges of the header (as wide as the viewport), so it never
        // spills off-screen whatever sits to the right of the switch. sm and up: 288 px under the switch.
        <div className="absolute inset-x-3 top-full z-50 mt-2 overflow-hidden sm:inset-x-auto sm:right-0 sm:w-72 rounded-xl border border-line bg-surface-elevated shadow-elev-3 animate-fade-in">
          <div className="border-b border-line px-3 py-2.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              {t('ride_assist.shift_label', { defaultValue: 'En turno' })}
            </p>
            {me?.whatsapp_phone ? (
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="truncate text-sm text-ink">
                  {t('ride_assist.shift_my_number', { phone: me.whatsapp_phone, defaultValue: 'Tu WhatsApp: {{phone}}' })}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => openDialog('change')}
                  className="shrink-0 text-xs font-semibold text-primary-700 underline hover:text-primary-800 disabled:opacity-60 dark:text-primary-400"
                >
                  {t('ride_assist.shift_change_number', { defaultValue: 'Cambiar número' })}
                </button>
              </div>
            ) : null}
          </div>
          <ul className="px-3 py-2.5 text-sm text-ink">
            {others.length === 0 ? (
              <li className="text-ink-muted">{t('ride_assist.shift_nobody_else', { defaultValue: 'No hay nadie más en turno.' })}</li>
            ) : (
              others.map((o) => (
                <li key={o.user_id}>{t('ride_assist.shift_also', { name: o.name, defaultValue: '{{name}} también está en turno' })}</li>
              ))
            )}
          </ul>
        </div>
      )}

      <AdminConfirmModal
        open={dialog !== null}
        title={t('ride_assist.shift_dialog_title', { defaultValue: 'Tu WhatsApp para el turno' })}
        message={
          numberError ??
          t('ride_assist.shift_dialog_message', {
            defaultValue: 'Los pasajeros y conductores te escribirán a este número cuando te toque un viaje. Con código de país, por ejemplo +53 51234567.',
          })
        }
        confirmLabel={
          dialog === 'change'
            ? t('ride_assist.shift_dialog_confirm_change', { defaultValue: 'Guardar número' })
            : t('ride_assist.shift_dialog_confirm', { defaultValue: 'Guardar y entrar en turno' })
        }
        cancelLabel={t('common.cancel')}
        onConfirm={confirmNumber}
        onCancel={closeDialog}
        inputValue={number}
        onInputChange={(v) => {
          setNumber(v);
          setNumberError(null);
        }}
        inputPlaceholder={t('ride_assist.shift_dialog_placeholder', { defaultValue: 'Número de WhatsApp' })}
        confirmDisabled={busy}
      />
    </div>
  );
}
