'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Copy, Download, ExternalLink, MessageCircle, UserPlus, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { driverOutreachService, type IncompleteDriverSignup, type OutreachChannel } from '@tricigo/api';
import { driverDocLabel, getErrorMessage, incompleteSignupMessage, waMeLink } from '@tricigo/utils';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import type { PaginationState } from '@/components/data/DataTablePagination';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { useToast } from '@/components/ui/AdminToast';
import { exportToCsv } from '@/lib/exportCsv';
import { formatAdminDate, formatAdminDateShort } from '@/lib/formatDate';

// Drivers stuck in pending_verification (they started the signup and never
// sent it), with what each one still has to upload, so the team can write to
// them by WhatsApp and log who wrote. Data: admin_incomplete_driver_signups()
// and driver_outreach_log from migration 00621.

type Filter = 'all' | 'uncontacted' | 'contacted' | 'no_docs' | 'partial';

const CHANNELS: OutreachChannel[] = ['whatsapp', 'llamada', 'sms', 'otro'];
const NOTE_MAX = 500;
const REQUIRED_DOC_COUNT = 5;
const DAY_MS = 86_400_000;

/**
 * PostgREST / Postgres codes for "this function or table does not exist":
 * migration 00621 is not in this database yet.
 */
const MISSING_BACKEND_CODES = new Set(['PGRST202', 'PGRST205', '42883', '42P01']);

interface LoadError {
  message: string;
  missingBackend: boolean;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Nothing uploaded at all, not even a document that was later rejected. */
function hasNoDocs(r: IncompleteDriverSignup): boolean {
  return r.docs_uploaded === 0 && r.rejected_docs.length === 0;
}

function signedInWithin(r: IncompleteDriverSignup, days: number): boolean {
  if (!r.last_sign_in_at) return false;
  return Date.now() - new Date(r.last_sign_in_at).getTime() <= days * DAY_MS;
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function relativeDays(iso: string, t: Translate): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
  if (days <= 0) return t('incomplete_drivers.relative_today', { defaultValue: 'hoy' });
  if (days === 1) return t('incomplete_drivers.relative_yesterday', { defaultValue: 'ayer' });
  if (days < 60) return t('incomplete_drivers.relative_days', { n: days, defaultValue: 'hace {{n}} días' });
  const months = Math.floor(days / 30);
  return t('incomplete_drivers.relative_months', { n: months, defaultValue: 'hace {{n}} meses' });
}

function messageFor(r: IncompleteDriverSignup): string {
  return incompleteSignupMessage({ fullName: r.full_name, missingDocs: r.missing_docs, rejectedDocs: r.rejected_docs });
}

const SORTABLE_KEYS = new Set([
  'full_name',
  'signed_up_at',
  'last_sign_in_at',
  'docs_uploaded',
  'contact_count',
  'last_contact_at',
]);

/** Client sort with empty values (never signed in, never contacted) always last. */
function sortRows(rows: IncompleteDriverSignup[], sort: SortState | null): IncompleteDriverSignup[] {
  if (!sort || !SORTABLE_KEYS.has(sort.columnId)) return rows;
  const dir = sort.direction === 'asc' ? 1 : -1;
  const key = sort.columnId as keyof IncompleteDriverSignup;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const aEmpty = av === null || av === undefined || av === '';
    const bEmpty = bv === null || bv === undefined || bv === '';
    if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), 'es') * dir;
  });
}

const inputCls =
  'w-full rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none';

function ContactDialog({
  row,
  channelLabels,
  onClose,
  onSaved,
}: {
  row: IncompleteDriverSignup;
  channelLabels: Record<OutreachChannel, string>;
  onClose: () => void;
  onSaved: (row: IncompleteDriverSignup) => void;
}) {
  const { t } = useTranslation('admin');
  const [channel, setChannel] = useState<OutreachChannel>('whatsapp');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, saving]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await driverOutreachService.logContact(row.driver_profile_id, channel, note);
      onSaved(row);
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  const name = row.full_name?.trim() || t('incomplete_drivers.no_name', { defaultValue: 'Sin nombre' });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-dialog-title"
        className="my-auto max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-surface-elevated p-5 shadow-elev-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="contact-dialog-title" className="font-display text-[17px] font-semibold text-ink">
              {t('incomplete_drivers.dialog_title', { defaultValue: 'Marcar como contactado' })}
            </h3>
            <p className="mt-0.5 truncate text-[12.5px] text-ink-muted">
              {name}
              {row.phone ? ` · ${row.phone}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label={t('incomplete_drivers.dialog_close', { defaultValue: 'Cerrar' })}
            className="rounded-md p-1 text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              {t('incomplete_drivers.field_channel', { defaultValue: 'Canal' })}
            </span>
            <select
              ref={firstFieldRef}
              value={channel}
              onChange={(e) => setChannel(e.target.value as OutreachChannel)}
              disabled={saving}
              className={`${inputCls} h-9`}
            >
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {channelLabels[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              {t('incomplete_drivers.field_note', { defaultValue: 'Nota (opcional)' })}
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
              maxLength={NOTE_MAX}
              rows={3}
              disabled={saving}
              placeholder={t('incomplete_drivers.placeholder_note', {
                defaultValue: 'Ej.: dice que sube la licencia esta semana',
              })}
              className={`${inputCls} resize-y py-2`}
            />
            <span className="self-end font-mono text-[10.5px] text-ink-subtle" data-tabular>
              {note.length}/{NOTE_MAX}
            </span>
          </label>

          {error && (
            <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-700 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg px-3.5 py-2 text-[12.5px] font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:opacity-50"
            >
              {t('incomplete_drivers.cancel', { defaultValue: 'Cancelar' })}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3.5 py-2 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {saving
                ? t('incomplete_drivers.saving', { defaultValue: 'Guardando…' })
                : t('incomplete_drivers.save_contact', { defaultValue: 'Guardar contacto' })}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function IncompleteDriversPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [rows, setRows] = useState<IncompleteDriverSignup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState | null>({ columnId: 'signed_up_at', direction: 'desc' });
  const [pagination, setPagination] = useState<PaginationState>({ page: 0, pageSize: 25 });
  const [contactRow, setContactRow] = useState<IncompleteDriverSignup | null>(null);
  const request = useRef(0);

  /**
   * `silent` keeps the table on screen (the reload after logging a contact):
   * no skeleton, and a failure leaves the current rows instead of the error
   * state. Returns whether the list was refreshed.
   */
  const load = useCallback(async (silent = false): Promise<boolean> => {
    const id = ++request.current;
    if (!silent) setLoading(true);
    try {
      const data = await driverOutreachService.getIncompleteSignups();
      if (id === request.current) {
        setRows(data);
        setError(null);
      }
      return true;
    } catch (err) {
      if (id === request.current && !silent) {
        const code = (err as { code?: unknown } | null)?.code;
        setRows([]);
        setError({
          message: getErrorMessage(err),
          missingBackend: typeof code === 'string' && MISSING_BACKEND_CODES.has(code),
        });
      }
      return false;
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const channelLabels = useMemo<Record<OutreachChannel, string>>(
    () => ({
      whatsapp: t('incomplete_drivers.channel_whatsapp', { defaultValue: 'WhatsApp' }),
      llamada: t('incomplete_drivers.channel_llamada', { defaultValue: 'Llamada' }),
      sms: t('incomplete_drivers.channel_sms', { defaultValue: 'SMS' }),
      otro: t('incomplete_drivers.channel_otro', { defaultValue: 'Otro' }),
    }),
    [t],
  );

  const totals = useMemo(
    () => ({
      total: rows.length,
      noDocs: rows.filter(hasNoDocs).length,
      partial: rows.filter((r) => !hasNoDocs(r)).length,
      contacted: rows.filter((r) => r.contact_count > 0).length,
      recent: rows.filter((r) => signedInWithin(r, 7)).length,
    }),
    [rows],
  );

  const searched = useMemo(() => {
    const q = search.trim();
    if (!q) return rows;
    const text = fold(q);
    const digits = q.replace(/\D/g, '');
    return rows.filter((r) => {
      if (fold(r.full_name ?? '').includes(text)) return true;
      return digits.length >= 3 && (r.phone ?? '').replace(/\D/g, '').includes(digits);
    });
  }, [rows, search]);

  const counts = useMemo(
    () => ({
      all: searched.length,
      uncontacted: searched.filter((r) => r.contact_count === 0).length,
      contacted: searched.filter((r) => r.contact_count > 0).length,
      no_docs: searched.filter(hasNoDocs).length,
      partial: searched.filter((r) => !hasNoDocs(r)).length,
    }),
    [searched],
  );

  const filtered = useMemo(() => {
    const matches = (r: IncompleteDriverSignup) => {
      switch (filter) {
        case 'uncontacted':
          return r.contact_count === 0;
        case 'contacted':
          return r.contact_count > 0;
        case 'no_docs':
          return hasNoDocs(r);
        case 'partial':
          return !hasNoDocs(r);
        default:
          return true;
      }
    };
    return sortRows(searched.filter(matches), sort);
  }, [searched, filter, sort]);

  // Back to the first page whenever the list itself changes shape.
  useEffect(() => {
    setPagination((p) => (p.page === 0 ? p : { ...p, page: 0 }));
  }, [filter, search, sort]);

  // A reload can shrink the list under the current page (a contacted driver
  // leaves "Sin contactar"), so clamp instead of showing an empty page.
  const page = Math.min(pagination.page, Math.max(0, Math.ceil(filtered.length / pagination.pageSize) - 1));
  const pageRows = useMemo(() => {
    const start = page * pagination.pageSize;
    return filtered.slice(start, start + pagination.pageSize);
  }, [filtered, page, pagination.pageSize]);

  const handleCopy = useCallback(
    async (row: IncompleteDriverSignup) => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(messageFor(row));
        showToast('success', t('incomplete_drivers.toast_copied', { defaultValue: 'Mensaje copiado' }));
      } catch {
        showToast(
          'error',
          t('incomplete_drivers.toast_copy_failed', {
            defaultValue: 'No se pudo copiar el mensaje. Ábrelo con el botón de WhatsApp.',
          }),
        );
      }
    },
    [showToast, t],
  );

  const closeDialog = useCallback(() => setContactRow(null), []);

  const handleSaved = useCallback(
    (row: IncompleteDriverSignup) => {
      setContactRow(null);
      showToast(
        'success',
        t('incomplete_drivers.toast_logged', {
          name: row.full_name?.trim() || row.phone || '',
          defaultValue: 'Contacto registrado: {{name}}',
        }),
      );
      void load(true).then((ok) => {
        if (!ok) {
          showToast(
            'warning',
            t('incomplete_drivers.toast_reload_failed', {
              defaultValue: 'El contacto se guardó, pero no pudimos actualizar la lista. Recarga la página.',
            }),
          );
        }
      });
    },
    [load, showToast, t],
  );

  const handleExport = useCallback(() => {
    const yes = t('incomplete_drivers.yes', { defaultValue: 'Sí' });
    const no = t('incomplete_drivers.no', { defaultValue: 'No' });
    const labels = (docs: string[]) => docs.map(driverDocLabel).join(', ');
    exportToCsv(
      filtered.map((r) => ({
        full_name: r.full_name ?? '',
        phone: r.phone ?? '',
        signed_up_at: formatAdminDate(r.signed_up_at),
        last_sign_in_at: r.last_sign_in_at ? formatAdminDate(r.last_sign_in_at) : '',
        docs_uploaded: `${r.docs_uploaded}/${REQUIRED_DOC_COUNT}`,
        missing_docs: labels(r.missing_docs),
        rejected_docs: labels(r.rejected_docs),
        has_push: r.has_push ? yes : no,
        contact_count: r.contact_count,
        last_contact_at: r.last_contact_at ? formatAdminDate(r.last_contact_at) : '',
        last_contact_by: r.last_contact_by ?? '',
        last_contact_channel: r.last_contact_channel ? channelLabels[r.last_contact_channel] ?? r.last_contact_channel : '',
        last_contact_note: r.last_contact_note ?? '',
      })),
      [
        { key: 'full_name', label: t('incomplete_drivers.col_name', { defaultValue: 'Nombre' }) },
        { key: 'phone', label: t('incomplete_drivers.csv_phone', { defaultValue: 'Teléfono' }) },
        { key: 'signed_up_at', label: t('incomplete_drivers.col_signed_up', { defaultValue: 'Registro' }) },
        { key: 'last_sign_in_at', label: t('incomplete_drivers.col_last_sign_in', { defaultValue: 'Último ingreso' }) },
        { key: 'docs_uploaded', label: t('incomplete_drivers.csv_docs_uploaded', { defaultValue: 'Documentos subidos' }) },
        { key: 'missing_docs', label: t('incomplete_drivers.csv_missing', { defaultValue: 'Faltan' }) },
        { key: 'rejected_docs', label: t('incomplete_drivers.csv_rejected', { defaultValue: 'Rechazados' }) },
        { key: 'has_push', label: t('incomplete_drivers.col_push', { defaultValue: 'Push' }) },
        { key: 'contact_count', label: t('incomplete_drivers.csv_contacts', { defaultValue: 'Contactos' }) },
        { key: 'last_contact_at', label: t('incomplete_drivers.col_last_contact', { defaultValue: 'Último contacto' }) },
        { key: 'last_contact_by', label: t('incomplete_drivers.csv_contact_by', { defaultValue: 'Contactado por' }) },
        { key: 'last_contact_channel', label: t('incomplete_drivers.field_channel', { defaultValue: 'Canal' }) },
        { key: 'last_contact_note', label: t('incomplete_drivers.csv_note', { defaultValue: 'Nota' }) },
      ],
      'choferes-sin-terminar-registro',
    );
  }, [filtered, channelLabels, t]);

  const tabs: StatusTab<Filter>[] = useMemo(
    () => [
      { id: 'all', label: t('incomplete_drivers.tab_all', { defaultValue: 'Todos' }), count: counts.all },
      {
        id: 'uncontacted',
        label: t('incomplete_drivers.tab_uncontacted', { defaultValue: 'Sin contactar' }),
        count: counts.uncontacted,
      },
      {
        id: 'contacted',
        label: t('incomplete_drivers.tab_contacted', { defaultValue: 'Contactados' }),
        count: counts.contacted,
      },
      {
        id: 'no_docs',
        label: t('incomplete_drivers.tab_no_docs', { defaultValue: 'Sin documentos' }),
        count: counts.no_docs,
      },
      { id: 'partial', label: t('incomplete_drivers.tab_partial', { defaultValue: 'A medias' }), count: counts.partial },
    ],
    [t, counts],
  );

  const columns: DataColumn<IncompleteDriverSignup>[] = useMemo(
    () => [
      {
        id: 'full_name',
        header: t('incomplete_drivers.col_name', { defaultValue: 'Nombre' }),
        cell: (r) => (
          <span className="flex min-w-0 flex-col">
            <span className="font-medium text-ink">
              {r.full_name?.trim() || t('incomplete_drivers.no_name', { defaultValue: 'Sin nombre' })}
            </span>
            <span className="font-mono text-[11.5px] font-normal text-ink-muted" data-tabular>
              {r.phone || t('incomplete_drivers.no_phone', { defaultValue: 'Sin teléfono' })}
            </span>
          </span>
        ),
        primary: true,
        sortKey: 'full_name',
      },
      {
        id: 'signed_up_at',
        header: t('incomplete_drivers.col_signed_up', { defaultValue: 'Registro' }),
        cell: (r) => (
          <span className="flex flex-col" title={formatAdminDate(r.signed_up_at)}>
            <span className="whitespace-nowrap text-ink">{relativeDays(r.signed_up_at, t)}</span>
            <span className="whitespace-nowrap text-[11px] text-ink-muted">{formatAdminDateShort(r.signed_up_at)}</span>
          </span>
        ),
        sortKey: 'signed_up_at',
        width: '120px',
      },
      {
        id: 'last_sign_in_at',
        header: t('incomplete_drivers.col_last_sign_in', { defaultValue: 'Último ingreso' }),
        cell: (r) =>
          r.last_sign_in_at ? (
            <span
              className={`whitespace-nowrap ${
                signedInWithin(r, 7) ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-ink-muted'
              }`}
              title={formatAdminDate(r.last_sign_in_at)}
            >
              {relativeDays(r.last_sign_in_at, t)}
            </span>
          ) : (
            <span className="text-ink-subtle">{t('incomplete_drivers.never', { defaultValue: 'Nunca' })}</span>
          ),
        sortKey: 'last_sign_in_at',
        hideBelow: 'lg',
        width: '120px',
      },
      {
        id: 'docs_uploaded',
        header: t('incomplete_drivers.col_docs', { defaultValue: 'Documentos' }),
        cell: (r) => (
          <span className="flex min-w-0 flex-col gap-1.5">
            <span className="font-mono text-[12.5px] font-semibold text-ink" data-tabular>
              {r.docs_uploaded}/{REQUIRED_DOC_COUNT}
            </span>
            <span className="flex flex-wrap gap-1">
              {r.rejected_docs.map((d) => (
                <span
                  key={`rejected-${d}`}
                  className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-[10.5px] font-medium text-red-700 dark:text-red-400"
                >
                  {t('incomplete_drivers.doc_rejected', {
                    doc: driverDocLabel(d),
                    defaultValue: '{{doc}} · rechazado',
                  })}
                </span>
              ))}
              {r.missing_docs.map((d) => (
                <span
                  key={`missing-${d}`}
                  className="inline-flex items-center rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-[10.5px] text-ink-muted"
                >
                  {driverDocLabel(d)}
                </span>
              ))}
              {r.missing_docs.length === 0 && r.rejected_docs.length === 0 && (
                <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-800 dark:text-amber-400">
                  {t('incomplete_drivers.docs_complete', { defaultValue: 'Falta enviar la solicitud' })}
                </span>
              )}
            </span>
          </span>
        ),
        sortKey: 'docs_uploaded',
      },
      {
        id: 'has_push',
        header: t('incomplete_drivers.col_push', { defaultValue: 'Push' }),
        cell: (r) =>
          r.has_push ? (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-400">
              {t('incomplete_drivers.yes', { defaultValue: 'Sí' })}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">
              {t('incomplete_drivers.no', { defaultValue: 'No' })}
            </span>
          ),
        hideBelow: 'xl',
        width: '72px',
      },
      {
        id: 'last_contact_at',
        header: t('incomplete_drivers.col_last_contact', { defaultValue: 'Último contacto' }),
        cell: (r) =>
          r.contact_count === 0 || !r.last_contact_at ? (
            <span className="text-ink-subtle">{t('incomplete_drivers.never', { defaultValue: 'Nunca' })}</span>
          ) : (
            <span className="flex min-w-0 max-w-[260px] flex-col gap-0.5">
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="whitespace-nowrap text-ink" title={formatAdminDate(r.last_contact_at)}>
                  {relativeDays(r.last_contact_at, t)}
                </span>
                <span className="font-mono text-[10.5px] text-ink-subtle" data-tabular>
                  {r.contact_count === 1
                    ? t('incomplete_drivers.contact_count_one', { defaultValue: '1 contacto' })
                    : t('incomplete_drivers.contact_count_other', {
                        n: r.contact_count,
                        defaultValue: '{{n}} contactos',
                      })}
                </span>
              </span>
              <span className="text-[11px] text-ink-muted">
                {[
                  r.last_contact_by,
                  r.last_contact_channel ? (channelLabels[r.last_contact_channel] ?? r.last_contact_channel) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {r.last_contact_note && (
                <span className="line-clamp-2 text-[11px] italic text-ink-muted" title={r.last_contact_note}>
                  {r.last_contact_note}
                </span>
              )}
            </span>
          ),
        sortKey: 'last_contact_at',
        hideBelow: 'md',
      },
      {
        id: 'actions',
        header: t('incomplete_drivers.col_actions', { defaultValue: 'Acciones' }),
        cell: (r) => {
          const href = waMeLink(r.phone, messageFor(r));
          const iconBtn =
            'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink';
          return (
            <span className="flex flex-wrap items-center justify-end gap-1.5">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-700 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-emerald-800"
                >
                  <MessageCircle className="h-3.5 w-3.5" />
                  {t('incomplete_drivers.action_whatsapp', { defaultValue: 'WhatsApp' })}
                </a>
              ) : (
                <span
                  title={t('incomplete_drivers.whatsapp_unavailable', {
                    defaultValue: 'Este teléfono no sirve para WhatsApp',
                  })}
                >
                  <button
                    type="button"
                    disabled
                    className="inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-lg border border-line bg-surface-sunken px-2.5 text-[12px] font-medium text-ink-subtle"
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                    {t('incomplete_drivers.action_whatsapp', { defaultValue: 'WhatsApp' })}
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={() => setContactRow(r)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-sunken"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t('incomplete_drivers.action_mark_contacted', { defaultValue: 'Marcar contactado' })}
              </button>
              <button
                type="button"
                onClick={() => void handleCopy(r)}
                title={t('incomplete_drivers.action_copy', { defaultValue: 'Copiar mensaje' })}
                aria-label={t('incomplete_drivers.action_copy', { defaultValue: 'Copiar mensaje' })}
                className={iconBtn}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <Link
                href={`/drivers/${r.driver_profile_id}`}
                title={t('incomplete_drivers.action_profile', { defaultValue: 'Ver ficha del conductor' })}
                aria-label={t('incomplete_drivers.action_profile', { defaultValue: 'Ver ficha del conductor' })}
                className={iconBtn}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </span>
          );
        },
        align: 'right',
      },
    ],
    [t, channelLabels, handleCopy],
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('incomplete_drivers.page_eyebrow', { defaultValue: 'Gente · recuperación' })}
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          {t('incomplete_drivers.title', { defaultValue: 'Choferes sin terminar el registro' })}
        </h1>
        <p className="mt-0.5 max-w-[80ch] text-[12.5px] text-ink-muted">
          {t('incomplete_drivers.description', {
            defaultValue:
              'Empezaron el registro como conductor y nunca enviaron la solicitud. Escríbeles por WhatsApp con el mensaje ya armado y marca a quién contactaste.',
          })}
        </p>
        <p className="mt-1 max-w-[80ch] text-[12px] text-ink-subtle">
          {t('incomplete_drivers.docs_only_note', {
            defaultValue:
              'El vehículo y el número de carné solo se guardan cuando el conductor envía la solicitud, así que aquí solo se ven los documentos que ya subió.',
          })}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          label={t('incomplete_drivers.kpi_total', { defaultValue: 'Sin terminar' })}
          value={error ? '—' : totals.total.toLocaleString('es-CU')}
          loading={loading}
        />
        <KpiCard
          label={t('incomplete_drivers.kpi_no_docs', { defaultValue: 'Sin ningún documento' })}
          value={error ? '—' : totals.noDocs.toLocaleString('es-CU')}
          tone="warning"
          loading={loading}
        />
        <KpiCard
          label={t('incomplete_drivers.kpi_partial', { defaultValue: 'Con documentos a medias' })}
          value={error ? '—' : totals.partial.toLocaleString('es-CU')}
          tone="info"
          loading={loading}
        />
        <KpiCard
          label={t('incomplete_drivers.kpi_contacted', { defaultValue: 'Contactados' })}
          value={error ? '—' : totals.contacted.toLocaleString('es-CU')}
          hint={
            error
              ? undefined
              : t('incomplete_drivers.kpi_contacted_hint', {
                  n: (totals.total - totals.contacted).toLocaleString('es-CU'),
                  defaultValue: '{{n}} sin contactar',
                })
          }
          tone="success"
          loading={loading}
        />
        <KpiCard
          label={t('incomplete_drivers.kpi_recent', { defaultValue: 'Entraron en 7 días' })}
          value={error ? '—' : totals.recent.toLocaleString('es-CU')}
          hint={
            error
              ? undefined
              : t('incomplete_drivers.kpi_recent_hint', { defaultValue: 'Abrieron la app en la última semana' })
          }
          tone="primary"
          loading={loading}
        />
      </div>

      <FilterBar<Filter>
        sticky
        tabs={tabs}
        activeTab={filter}
        onTabChange={setFilter}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t('incomplete_drivers.search_placeholder', { defaultValue: 'Buscar por nombre o teléfono' }),
        }}
        actions={
          <button
            type="button"
            onClick={handleExport}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {t('incomplete_drivers.export_csv', { defaultValue: 'Exportar CSV' })}
          </button>
        }
      />

      <DataTable<IncompleteDriverSignup>
        columns={columns}
        rows={pageRows}
        keyField="driver_profile_id"
        loading={loading}
        empty={
          error
            ? {
                icon: AlertTriangle,
                tone: 'warning',
                title: t('incomplete_drivers.error_title', { defaultValue: 'No pudimos cargar la lista' }),
                body: (
                  <>
                    {error.missingBackend
                      ? t('incomplete_drivers.error_missing', {
                          defaultValue:
                            'La base de datos todavía no tiene esta función. Hay que aplicar la migración 00621 para ver esta página.',
                        })
                      : t('incomplete_drivers.error_generic', { defaultValue: 'Reintenta en un momento.' })}
                    <span className="mt-1 block break-words font-mono text-[11px] text-ink-subtle">{error.message}</span>
                  </>
                ),
                action: {
                  label: t('incomplete_drivers.retry', { defaultValue: 'Reintentar' }),
                  onClick: () => void load(),
                },
              }
            : rows.length === 0
              ? {
                  icon: UserPlus,
                  tone: 'success',
                  title: t('incomplete_drivers.empty_title', { defaultValue: 'Nadie quedó a medias' }),
                  body: t('incomplete_drivers.empty_body', {
                    defaultValue: 'Todos los conductores que empezaron el registro ya enviaron su solicitud.',
                  }),
                }
              : {
                  icon: UserPlus,
                  title: t('incomplete_drivers.no_results_title', { defaultValue: 'Sin resultados' }),
                  body: t('incomplete_drivers.no_results_body', {
                    defaultValue: 'Prueba con otra pestaña o limpia la búsqueda.',
                  }),
                }
        }
        sort={sort}
        onSortChange={setSort}
        pagination={{ ...pagination, page, total: filtered.length }}
        onPaginationChange={setPagination}
      />

      {contactRow && (
        <ContactDialog row={contactRow} channelLabels={channelLabels} onClose={closeDialog} onSaved={handleSaved} />
      )}
    </div>
  );
}
