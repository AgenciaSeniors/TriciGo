'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { MessageCircle, PhoneMissed, Ticket } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import {
  missedRideService,
  type MissedRider,
  type MissedRideCoupon,
  type MissedRideCouponReason,
  type MissedRiderView,
} from '@tricigo/api';
import { apologyDiscountText, missedRideApologyMessage, waMeLink } from '@tricigo/utils';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { useToast } from '@/components/ui/AdminToast';
import { formatAdminDate } from '@/lib/formatDate';
import { usePanelCan } from '@/lib/usePanelCan';
import { isOpsStaleError, opsErrorMessage } from '@/lib/opsErrors';

// People whose request found no driver and who have not ridden since (00674). Operators write to
// each one by WhatsApp; the server records the contact and gives them the apology coupon, which
// applies on its own on their next ride. Data: admin_missed_riders, admin_missed_ride_coupon and
// ops_contact_missed_rider.

type Days = '30' | '90' | 'all';
const DAYS: Days[] = ['30', '90', 'all'];

function daysParam(d: Days): number | null {
  return d === 'all' ? null : Number(d);
}

export default function MissedRidesPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const { can } = usePanelCan();
  const canWrite = can('riders.outreach');

  const [view, setView] = useState<MissedRiderView>('pending');
  const [days, setDays] = useState<Days>('30');
  const [rows, setRows] = useState<MissedRider[]>([]);
  const [coupon, setCoupon] = useState<MissedRideCoupon | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [blockedLink, setBlockedLink] = useState<string | null>(null);
  const request = useRef(0);

  /** `silent` keeps the table on screen (the reload after a contact). */
  const load = useCallback(async (silent = false) => {
    const id = ++request.current;
    if (!silent) setLoading(true);
    try {
      const [list, current] = await Promise.all([
        missedRideService.list(view, daysParam(days)),
        missedRideService.currentCoupon(),
      ]);
      if (id !== request.current) return;
      setRows(list);
      setCoupon(current);
      setError(null);
    } catch (err) {
      if (id !== request.current) return;
      if (!silent) setRows([]);
      setError(opsErrorMessage(err, t));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [view, days, t]);

  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
    void load();
  }, [load]);

  const reasonText = useCallback((reason: MissedRideCouponReason): string => {
    switch (reason) {
      case 'no_coupon_available':
        return t('missed_rides.reason_no_coupon_available', { defaultValue: 'No hay cupón activo: el mensaje sale sin descuento' });
      case 'already_given':
        return t('missed_rides.reason_already_given', { defaultValue: 'Este teléfono ya recibió un cupón: el mensaje sale sin descuento' });
      case 'coupon_used':
        return t('missed_rides.reason_coupon_used', { defaultValue: 'Ya usó su cupón: el mensaje sale sin descuento' });
      default:
        return t('missed_rides.reason_coupon_unusable', { defaultValue: 'Su cupón ya no tiene efecto: el mensaje sale sin descuento' });
    }
  }, [t]);

  const write = useCallback(async (r: MissedRider) => {
    if (!r.phone || !r.last_failed_at || busy) return;
    // Open the tab on the click itself: once the server has answered, the browser blocks it.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    setBusy(r.user_id);
    setBlockedLink(null);
    try {
      const res = await missedRideService.contact(r.user_id, r.last_failed_at);
      const href = waMeLink(
        res.phone,
        missedRideApologyMessage({ fullName: res.fullName, failedAt: res.lastFailedAt, coupon: res.coupon }),
      );
      if (!href) throw new Error(t('missed_rides.no_whatsapp', { defaultValue: 'Este teléfono no sirve para WhatsApp' }));
      if (tab) tab.location.href = href;
      else setBlockedLink(href);
      if (res.couponReason) {
        showToast('warning', reasonText(res.couponReason));
      } else if (res.coupon) {
        showToast('success', t('missed_rides.toast_sent_coupon', {
          code: res.coupon.code, defaultValue: 'Mensaje listo en WhatsApp, con el cupón {{code}}',
        }));
      } else {
        showToast('success', t('missed_rides.toast_sent', { defaultValue: 'Mensaje listo en WhatsApp' }));
      }
      void latestLoad.current(true);
    } catch (err) {
      tab?.close();
      showToast('error', opsErrorMessage(err, t));
      if (isOpsStaleError(err)) void latestLoad.current(true);
    } finally {
      setBusy(null);
    }
  }, [busy, reasonText, showToast, t]);

  const tabs: StatusTab<MissedRiderView>[] = useMemo(() => [
    { id: 'pending', label: t('missed_rides.tab_pending', { defaultValue: 'Por contactar' }) },
    { id: 'contacted', label: t('missed_rides.tab_contacted', { defaultValue: 'Contactados' }) },
  ], [t]);

  const couponText = useCallback((r: MissedRider): string => {
    switch (r.coupon_status) {
      case 'granted':
        return t('missed_rides.coupon_status_granted', { code: r.coupon_code ?? '', defaultValue: 'Cupón dado ({{code}})' });
      case 'used':
        return t('missed_rides.coupon_status_used', { defaultValue: 'Cupón usado' });
      case 'unusable':
        return t('missed_rides.coupon_status_unusable', { defaultValue: 'Cupón sin efecto' });
      default:
        return t('missed_rides.coupon_status_none', { defaultValue: 'Sin cupón' });
    }
  }, [t]);

  const columns: DataColumn<MissedRider>[] = useMemo(() => [
    {
      id: 'person',
      header: t('missed_rides.col_person', { defaultValue: 'Persona' }),
      primary: true,
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-ink">
            {r.full_name?.trim() || t('missed_rides.no_name', { defaultValue: 'Sin nombre' })}
          </span>
          <span className="font-mono text-[11px] text-ink-muted" data-tabular>
            {r.phone ? `+${r.phone}` : t('missed_rides.no_phone', { defaultValue: 'Sin teléfono confirmado' })}
          </span>
        </span>
      ),
    },
    {
      id: 'last_failure',
      header: t('missed_rides.col_last_failure', { defaultValue: 'Último pedido sin chofer' }),
      cell: (r) => r.last_failed_at ? (
        <span className="flex min-w-0 flex-col">
          <span className="text-ink">{formatAdminDate(r.last_failed_at)}</span>
          <span className="truncate text-[11px] text-ink-muted">
            {[r.last_pickup, r.last_dropoff].filter(Boolean).join(' → ')}
          </span>
        </span>
      ) : '—',
    },
    {
      id: 'requests',
      header: t('missed_rides.col_requests', { defaultValue: 'Pedidos' }),
      align: 'right',
      hideBelow: 'md',
      cell: (r) => <span data-tabular>{r.failed_requests}</span>,
    },
    {
      id: 'status',
      header: t('missed_rides.col_status', { defaultValue: 'Estado' }),
      cell: (r) => (
        <span className="flex flex-col gap-0.5 text-[12px]">
          <span className="text-ink">
            {r.contacts > 0 && r.last_contacted_at
              ? t('missed_rides.status_contacted', {
                  name: r.last_contacted_by ?? '—',
                  date: formatAdminDate(r.last_contacted_at),
                  defaultValue: 'Contactado por {{name}} · {{date}}',
                })
              : t('missed_rides.status_pending', { defaultValue: 'Sin contactar' })}
          </span>
          <span className="text-ink-muted">{couponText(r)}</span>
          {r.phone_already_rewarded && (
            <span className="text-amber-800 dark:text-amber-400">
              {t('missed_rides.phone_already_rewarded', { defaultValue: 'Este teléfono ya recibió un cupón' })}
            </span>
          )}
          {r.rode_after_contact && (
            <span className="text-emerald-700 dark:text-emerald-400">
              {t('missed_rides.rode_again', { defaultValue: 'Volvió a viajar' })}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'actions',
      header: t('missed_rides.col_actions', { defaultValue: 'Acciones' }),
      align: 'right',
      cell: (r) => {
        const title = !r.phone
          ? t('missed_rides.write_no_phone', { defaultValue: 'Sin teléfono confirmado no se le puede escribir' })
          : !r.in_segment
            ? t('missed_rides.write_not_in_segment', { defaultValue: 'Ya volvió a viajar o su cuenta cambió' })
            : undefined;
        return (
          <button
            type="button"
            onClick={() => void write(r)}
            disabled={!canWrite || !r.phone || !r.in_segment || busy !== null}
            title={title}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-700 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            {busy === r.user_id
              ? t('missed_rides.writing', { defaultValue: 'Preparando…' })
              : r.contacts > 0
                ? t('missed_rides.action_write_again', { defaultValue: 'Volver a escribir' })
                : t('missed_rides.action_write', { defaultValue: 'Escribir por WhatsApp' })}
          </button>
        );
      },
    },
  ], [busy, canWrite, couponText, t, write]);

  const discount = coupon
    ? apologyDiscountText({
        type: coupon.type,
        discountPercent: coupon.discount_percent,
        discountFixedCup: coupon.discount_fixed_cup,
        validUntil: coupon.valid_until,
      })
    : null;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[13px] text-ink-muted">
        {t('missed_rides.intro', {
          defaultValue:
            'Personas que pidieron un viaje, no consiguieron conductor y no volvieron a viajar. Escríbeles por WhatsApp: el cupón de disculpa se les aplica solo en el próximo viaje.',
        })}
      </p>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-start gap-3">
          <Ticket className="mt-0.5 h-4 w-4 shrink-0 text-primary-700 dark:text-primary-400" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
              {t('missed_rides.coupon_title', { defaultValue: 'Cupón de disculpa' })}
            </p>
            {coupon ? (
              <>
                <p className="mt-1 text-[14px] text-ink">
                  <span className="font-mono font-medium">{coupon.code}</span>
                  {discount && (
                    <> · {t('missed_rides.coupon_discount', { discount, defaultValue: '{{discount}} de descuento' })}</>
                  )}
                </p>
                <p className="mt-0.5 text-[12px] text-ink-muted">
                  {[
                    coupon.valid_until
                      ? t('missed_rides.coupon_valid_until', { date: formatAdminDate(coupon.valid_until), defaultValue: 'Vale hasta {{date}}' })
                      : null,
                    coupon.max_uses != null
                      ? t('missed_rides.coupon_uses', { used: coupon.current_uses, max: coupon.max_uses, defaultValue: '{{used}} de {{max}} usos' })
                      : null,
                  ].filter(Boolean).join(' · ')}
                </p>
              </>
            ) : (
              <p className="mt-1 text-[13px] text-ink">
                {t('missed_rides.coupon_none', { defaultValue: 'No hay cupón de disculpa activo: los mensajes salen sin descuento.' })}{' '}
                <Link href="/promotions" className="font-medium text-primary-700 underline dark:text-primary-400">
                  {t('missed_rides.coupon_link', { defaultValue: 'Crearlo en Promociones' })}
                </Link>
              </p>
            )}
          </div>
        </div>
      </section>

      {blockedLink && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-400"
        >
          <span>{t('missed_rides.popup_blocked', { defaultValue: 'El navegador no abrió la pestaña de WhatsApp.' })}</span>
          <a href={blockedLink} target="_blank" rel="noopener noreferrer" onClick={() => setBlockedLink(null)} className="font-medium underline">
            {t('missed_rides.popup_open', { defaultValue: 'Abrir WhatsApp' })}
          </a>
        </div>
      )}

      <FilterBar
        tabs={tabs}
        activeTab={view}
        onTabChange={setView}
        actions={
          <select
            value={days}
            onChange={(e) => setDays(e.target.value as Days)}
            aria-label={t('missed_rides.days_label', { defaultValue: 'Período' })}
            className="h-8 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink"
          >
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {d === 'all'
                  ? t('missed_rides.days_all', { defaultValue: 'Todo' })
                  : t('missed_rides.days_n', { n: d, defaultValue: 'Últimos {{n}} días' })}
              </option>
            ))}
          </select>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        keyField="user_id"
        loading={loading}
        error={error}
        onRetry={() => void load()}
        empty={{
          icon: PhoneMissed,
          title: view === 'pending'
            ? t('missed_rides.empty_pending', { defaultValue: 'Nadie por contactar en este período' })
            : t('missed_rides.empty_contacted', { defaultValue: 'Todavía no se le escribió a nadie en este período' }),
        }}
      />
    </div>
  );
}
