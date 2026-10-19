'use client';

// ============================================================
// The four referral amounts in CUP (00666). Admins and marketing edit them
// here; set_referral_amounts validates them again on the server and
// tg_platform_config_audit records who changed each one. The payout triggers
// read the amounts when they pay, so a change applies to the next payments.
// ============================================================

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import {
  referralService,
  REFERRAL_AMOUNT_KEYS,
  type ReferralAmountKey,
  type ReferralAmounts,
} from '@tricigo/api/services/referral';
import { formatCUP, getErrorMessage } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { SectionCard } from '@/components/dashboard/SectionCard';

type Draft = Record<ReferralAmountKey, string>;

/** The server stores and pays these as Postgres integer (int4). */
const INT4_MAX = 2147483647;

const DEFAULT_TEXT: Record<ReferralAmountKey, { label: string; help: string }> = {
  referral_bonus_cup: {
    label: 'Por traer un pasajero',
    help: 'Lo recibe quien invitó, cuando el pasajero invitado completa su primer viaje.',
  },
  referral_bonus_driver_cup: {
    label: 'Por traer un chofer',
    help: 'Lo recibe quien invitó, cuando el chofer invitado completa su primer viaje. 0 usa el monto por pasajero.',
  },
  referral_welcome_bonus_cup: {
    label: 'Bienvenida para el pasajero invitado',
    help: 'Lo recibe el pasajero invitado en su primer viaje. 0 = apagado.',
  },
  referral_welcome_bonus_driver_cup: {
    label: 'Bienvenida para el chofer invitado',
    help: 'Lo recibe el chofer invitado en su primer viaje. 0 usa la bienvenida del pasajero.',
  },
};

const inputCls =
  'h-9 w-full rounded-lg border border-line bg-surface px-2.5 font-mono text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none aria-[invalid=true]:border-amber-500 disabled:opacity-60';

function toDraft(amounts: ReferralAmounts): Draft {
  return Object.fromEntries(REFERRAL_AMOUNT_KEYS.map((k) => [k, String(amounts[k])])) as Draft;
}

/** A whole number of CUP, 0 or more, that fits the server's integer. */
function parseAmount(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n <= INT4_MAX ? n : null;
}

export function ReferralAmountsCard() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [saved, setSaved] = useState<ReferralAmounts | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldId = useId();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const amounts = await referralService.getReferralAmounts();
      setSaved(amounts);
      setDraft(toDraft(amounts));
    } catch (err) {
      setLoadError(getErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keys whose field no longer holds the saved amount ("0500" for 500 is not
  // a change). A field left as loaded is never re-validated, so an odd stored
  // value does not block saving the others.
  const changedKeys = useMemo(
    () =>
      saved && draft
        ? REFERRAL_AMOUNT_KEYS.filter((k) => {
            const text = draft[k].trim();
            return text !== String(saved[k]) && parseAmount(text) !== saved[k];
          })
        : [],
    [saved, draft],
  );

  const handleSave = async () => {
    if (!draft || changedKeys.length === 0) return;
    const changes: Partial<ReferralAmounts> = {};
    for (const k of changedKeys) {
      const n = parseAmount(draft[k]);
      if (n === null) {
        showToast(
          'error',
          t('referrals.amounts_invalid', { defaultValue: 'Los montos tienen que ser números enteros, 0 o más.' }),
        );
        return;
      }
      changes[k] = n;
    }
    setSaving(true);
    try {
      const next = await referralService.setReferralAmounts(changes);
      setSaved(next);
      setDraft(toDraft(next));
      showToast(
        'success',
        t('referrals.amounts_saved', {
          defaultValue: 'Montos guardados. Se aplican a los próximos referidos que se paguen.',
        }),
      );
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title={t('referrals.amounts_title', { defaultValue: 'Montos de referidos (CUP)' })}
      description={t('referrals.amounts_help', {
        defaultValue:
          'Se pagan en la billetera cuando la persona invitada completa su primer viaje, una sola vez por teléfono. Un cambio vale para los próximos pagos.',
      })}
    >
      {loadError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-[12.5px]">
          <span className="text-red-700 dark:text-red-400">
            {t('referrals.amounts_load_error', { defaultValue: 'No pudimos cargar los montos.' })}
          </span>
          <span className="break-words font-mono text-[11px] text-ink-subtle">{loadError}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-8 items-center rounded-lg border border-line bg-surface px-3 text-[12px] font-medium text-ink transition-colors hover:bg-surface-sunken"
          >
            {t('referrals.amounts_retry', { defaultValue: 'Reintentar' })}
          </button>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
          className="flex flex-col gap-4"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {REFERRAL_AMOUNT_KEYS.map((k) => {
              const value = draft?.[k] ?? '';
              const changed = draft !== null && changedKeys.includes(k);
              const next = changed ? parseAmount(value) : null;
              const invalid = changed && next === null;
              const inputId = `${fieldId}-${k}`;
              const helpId = `${inputId}-help`;
              const errorId = `${inputId}-error`;
              const changeId = `${inputId}-change`;
              // Help and error sit outside the <label> so the label stays the field's name;
              // aria-describedby reads them, and the before/after line, with the input.
              const describedBy = [invalid ? errorId : null, next !== null ? changeId : null, helpId]
                .filter(Boolean)
                .join(' ');
              return (
                <div key={k} className="flex min-w-0 flex-col gap-1">
                  <label
                    htmlFor={inputId}
                    className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle"
                  >
                    {t(`referrals.amount_${k}`, { defaultValue: DEFAULT_TEXT[k].label })}
                  </label>
                  <input
                    id={inputId}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={value}
                    placeholder={draft ? undefined : '…'}
                    disabled={!draft || saving}
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    onChange={(e) => setDraft((d) => (d ? { ...d, [k]: e.target.value } : d))}
                    className={inputCls}
                  />
                  {invalid && (
                    <p id={errorId} className="text-[11px] leading-snug text-amber-800 dark:text-amber-400">
                      {t('referrals.amount_invalid_hint', { defaultValue: 'Un número entero, 0 o más.' })}
                    </p>
                  )}
                  {saved && next !== null && (
                    <p id={changeId} className="font-mono text-[11px] leading-snug text-ink">
                      <span aria-hidden="true">
                        {formatCUP(saved[k])} → {formatCUP(next)}
                      </span>
                      <span className="sr-only">
                        {t('referrals.amount_change', {
                          from: formatCUP(saved[k]),
                          to: formatCUP(next),
                          defaultValue: 'Cambia de {{from}} a {{to}}',
                        })}
                      </span>
                    </p>
                  )}
                  <p id={helpId} className="text-[11px] leading-snug text-ink-muted">
                    {t(`referrals.amount_${k}_help`, { defaultValue: DEFAULT_TEXT[k].help })}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {changedKeys.length > 0 && !saving && (
              <button
                type="button"
                onClick={() => saved && setDraft(toDraft(saved))}
                className="inline-flex h-9 items-center rounded-full border border-line bg-surface px-4 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken"
              >
                {t('referrals.amounts_discard', { defaultValue: 'Descartar cambios' })}
              </button>
            )}
            <button
              type="submit"
              disabled={!draft || saving || changedKeys.length === 0}
              className="inline-flex h-9 items-center rounded-full bg-ink px-4 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving
                ? t('referrals.amounts_saving', { defaultValue: 'Guardando…' })
                : t('referrals.amounts_save', { defaultValue: 'Guardar montos' })}
            </button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}
