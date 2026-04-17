'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Backpack,
  Check,
  FileText,
  Key,
  Laptop,
  Package,
  PackageSearch,
  Shirt,
  Smartphone,
  Wallet,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { lostItemService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';
import { formatCUP } from '@tricigo/utils';
import type { LostItem, LostItemStatus } from '@tricigo/types';
import { formatAdminDate } from '@/lib/formatDate';
import { useToast } from '@/components/ui/AdminToast';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { DataEmptyState } from '@/components/data/DataEmptyState';

type Filter = LostItemStatus | 'all';

const CATEGORY_ICON: Record<string, LucideIcon> = {
  phone: Smartphone,
  wallet: Wallet,
  bag: Backpack,
  clothing: Shirt,
  electronics: Laptop,
  documents: FileText,
  keys: Key,
  other: Package,
};

const CATEGORY_FALLBACK_ES: Record<string, string> = {
  phone: 'Teléfono',
  wallet: 'Billetera',
  bag: 'Mochila',
  clothing: 'Ropa',
  electronics: 'Electrónica',
  documents: 'Documentos',
  keys: 'Llaves',
  other: 'Otro',
};

type TFunction = (key: string, options?: { defaultValue?: string }) => string;

function categoryLabel(raw: string, t: TFunction): string {
  return t(`lost_found.category_${raw}`, { defaultValue: CATEGORY_FALLBACK_ES[raw] ?? raw });
}

export default function LostFoundPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [items, setItems] = useState<LostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<Filter>('reported');
  const [selected, setSelected] = useState<LostItem | null>(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [closing, setClosing] = useState(false);

  const TABS: StatusTab<Filter>[] = useMemo(() => [
    { id: 'all', label: t('lost_found.filter_all', { defaultValue: 'Todos' }) },
    { id: 'reported', label: t('lost_found.filter_reported', { defaultValue: 'Reportados' }), tone: 'info' },
    { id: 'found', label: t('lost_found.filter_found', { defaultValue: 'Encontrados' }), tone: 'success' },
    { id: 'not_found', label: t('lost_found.filter_not_found', { defaultValue: 'No encontrados' }), tone: 'danger' },
    { id: 'return_arranged', label: t('lost_found.filter_return_arranged', { defaultValue: 'Entrega agendada' }), tone: 'info' },
    { id: 'returned', label: t('lost_found.filter_returned', { defaultValue: 'Devueltos' }), tone: 'success' },
    { id: 'closed', label: t('lost_found.filter_closed', { defaultValue: 'Cerrados' }) },
  ], [t]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await lostItemService.getAllLostItems({
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 100,
      });
      setItems(data);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : t('lost_found.load_error', { defaultValue: 'No pudimos cargar los objetos perdidos.' }));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const handleSelect = (item: LostItem) => {
    setSelected(item);
    setAdminNotes(item.admin_notes ?? '');
  };

  const handleSaveNotes = async () => {
    if (!selected) return;
    try {
      await lostItemService.addAdminNotes(selected.id, adminNotes);
      setSelected((prev) => (prev ? { ...prev, admin_notes: adminNotes } : null));
      showToast('success', t('lost_found.toast_notes_saved', { defaultValue: 'Notas guardadas' }));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('lost_found.notes_error', { defaultValue: 'No pudimos guardar las notas.' }));
    }
  };

  const handleClose = async () => {
    if (!selected) return;
    setClosing(true);
    try {
      const updated = await lostItemService.closeLostItem(
        selected.id,
        adminUserId,
        adminNotes || undefined,
      );
      setItems((prev) => prev.map((i) => (i.id === selected.id ? updated : i)));
      setSelected(updated);
      showToast('success', t('lost_found.toast_closed', { defaultValue: 'Objeto marcado como cerrado' }));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('lost_found.close_error', { defaultValue: 'No pudimos cerrar el reporte.' }));
    } finally {
      setClosing(false);
    }
  };

  const renderList = () => {
    if (loading) {
      return (
        <div className="space-y-3 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl bg-surface-sunken p-3">
              <div className="h-9 w-9 animate-pulse rounded-xl bg-surface-elevated" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-3/4 animate-pulse rounded bg-surface-elevated" />
                <div className="h-2.5 w-1/3 animate-pulse rounded bg-surface-elevated" />
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (error) {
      return (
        <div className="p-6">
          <DataEmptyState
            icon={PackageSearch}
            tone="danger"
            title={t('lost_found.load_error_title', { defaultValue: 'No pudimos cargar los objetos' })}
            body={error}
            action={{ label: t('lost_found.retry', { defaultValue: 'Reintentar' }), onClick: () => void fetchItems() }}
          />
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div className="p-6">
          <DataEmptyState
            icon={PackageSearch}
            title={t('lost_found.empty_title', { defaultValue: 'Sin objetos reportados' })}
            body={t('lost_found.empty_body', { defaultValue: 'En este alcance todavía no hay objetos perdidos registrados.' })}
          />
        </div>
      );
    }
    return (
      <ul className="divide-y divide-line">
        {items.map((item) => {
          const Icon = CATEGORY_ICON[item.category] ?? Package;
          const active = selected?.id === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => handleSelect(item)}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                  active ? 'bg-primary-500/8' : 'hover:bg-surface-sunken'
                }`}
              >
                <span
                  className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${
                    active ? 'bg-primary-500/15 text-primary-500' : 'bg-surface-sunken text-ink-muted'
                  }`}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {categoryLabel(item.category, t)} · {item.description.slice(0, 48)}
                      {item.description.length > 48 ? '…' : ''}
                    </span>
                    <StatusBadge domain="lost_item" status={item.status} />
                  </span>
                  <span className="mt-1 flex items-center justify-between text-[11px] text-ink-subtle">
                    <span className="font-mono">{item.ride_id.slice(0, 10)}…</span>
                    <span>{formatAdminDate(item.created_at)}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('lost_found.page_eyebrow', { defaultValue: 'Operación · objetos perdidos' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('lost_found.title', { defaultValue: 'Objetos perdidos' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('lost_found.page_description', { defaultValue: 'Reportes de pertenencias olvidadas a bordo. Seguí el rastro hasta que vuelvan al dueño.' })}
          </p>
        </div>
      </div>

      <FilterBar<Filter>
        sticky
        tabs={TABS}
        activeTab={statusFilter}
        onTabChange={(id) => {
          setStatusFilter(id);
          setSelected(null);
        }}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="admin-card overflow-hidden lg:col-span-2">
          <div className="border-b border-line px-4 py-2.5">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
              {t('lost_found.tray_eyebrow', { defaultValue: 'Bandeja' })}
            </p>
            <h2 className="font-display text-[15px] font-semibold text-ink">
              {t('lost_found.tray_title', { defaultValue: 'Reportes' })} ({items.length})
            </h2>
          </div>
          <div className="max-h-[640px] overflow-y-auto">{renderList()}</div>
        </div>

        <div className="admin-card lg:col-span-3">
          {selected ? (
            <ItemDetail
              item={selected}
              adminNotes={adminNotes}
              onAdminNotesChange={setAdminNotes}
              onSaveNotes={() => void handleSaveNotes()}
              onClose={() => void handleClose()}
              closing={closing}
            />
          ) : (
            <div className="flex min-h-[480px] items-center justify-center p-6">
              <DataEmptyState
                icon={PackageSearch}
                title={t('lost_found.pick_title', { defaultValue: 'Elegí un reporte' })}
                body={t('lost_found.pick_body', { defaultValue: 'Seleccioná un objeto en la bandeja para ver los detalles y tomar acción.' })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ItemDetail({
  item,
  adminNotes,
  onAdminNotesChange,
  onSaveNotes,
  onClose,
  closing,
}: {
  item: LostItem;
  adminNotes: string;
  onAdminNotesChange: (v: string) => void;
  onSaveNotes: () => void;
  onClose: () => void;
  closing: boolean;
}) {
  const { t } = useTranslation('admin');
  const Icon = CATEGORY_ICON[item.category] ?? Package;
  const showClose = item.status !== 'returned' && item.status !== 'closed';
  const showReturn = item.status === 'return_arranged' || item.status === 'returned';

  return (
    <div className="flex max-h-[640px] flex-col overflow-y-auto">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-500/10 text-primary-500">
          <Icon className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <div className="flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
            {t('lost_found.field_category', { defaultValue: 'Categoría' })}
          </p>
          <h2 className="font-display text-[17px] font-semibold text-ink">
            {categoryLabel(item.category, t)}
          </h2>
        </div>
        <StatusBadge domain="lost_item" status={item.status} size="md" />
      </div>

      <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
            {t('lost_found.field_ride', { defaultValue: 'Viaje' })}
          </p>
          <p className="font-mono text-[12.5px] text-ink">{item.ride_id}</p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
            {t('lost_found.field_reported', { defaultValue: 'Reportado' })}
          </p>
          <p className="text-[12.5px] text-ink">{formatAdminDate(item.created_at)}</p>
        </div>
      </div>

      <section className="px-5 py-4">
        <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('lost_found.rider_story_title', { defaultValue: 'Relato del pasajero' })}
        </h3>
        <div className="rounded-xl border border-line bg-surface-sunken p-4">
          <p className="text-[13px] text-ink">{item.description}</p>
          {item.photo_urls.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {item.photo_urls.map((url, i) => (
                <a
                  key={i}
                  href={url}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted hover:text-ink"
                >
                  {t('lost_found.photo_label', { defaultValue: 'Foto' })} {i + 1}
                </a>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="px-5 py-4">
        <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('lost_found.driver_response_title', { defaultValue: 'Respuesta del conductor' })}
        </h3>
        <div className="rounded-xl border border-line bg-surface-sunken p-4">
          {item.driver_found !== null ? (
            <>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  item.driver_found
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'bg-red-500/10 text-red-600 dark:text-red-400'
                }`}
              >
                {item.driver_found ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                {item.driver_found
                  ? t('lost_found.driver_found_label', { defaultValue: 'Encontrado' })
                  : t('lost_found.driver_not_found_label', { defaultValue: 'No encontrado' })}
              </span>
              {item.driver_response && (
                <p className="mt-2 text-[13px] text-ink">{item.driver_response}</p>
              )}
            </>
          ) : (
            <p className="text-[12.5px] italic text-ink-subtle">
              {t('lost_found.no_driver_response', { defaultValue: 'Aún sin respuesta del conductor.' })}
            </p>
          )}
        </div>
      </section>

      {showReturn && (
        <section className="px-5 py-4">
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-400">
              {t('lost_found.return_title', { defaultValue: 'Detalles de entrega' })}
            </h3>
            {item.return_fee_cup != null && item.return_fee_cup > 0 && (
              <p className="text-[13px] text-ink">
                <span className="text-ink-muted">{t('lost_found.return_fee_label', { defaultValue: 'Tarifa:' })} </span>
                <span className="font-medium">{formatCUP(item.return_fee_cup)}</span>
              </p>
            )}
            {item.return_location && (
              <p className="text-[13px] text-ink">
                <span className="text-ink-muted">{t('lost_found.return_location_label', { defaultValue: 'Lugar:' })} </span>
                {item.return_location}
              </p>
            )}
            {item.return_notes && (
              <p className="mt-1 text-[12px] text-ink-muted">{item.return_notes}</p>
            )}
          </div>
        </section>
      )}

      <section className="px-5 py-4">
        <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('lost_found.admin_notes_title', { defaultValue: 'Notas internas' })}
        </h3>
        <textarea
          value={adminNotes}
          onChange={(e) => onAdminNotesChange(e.target.value)}
          placeholder={t('lost_found.admin_notes_placeholder', { defaultValue: 'Detalles de gestión, contactos, próximos pasos…' })}
          className="min-h-[80px] w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none"
        />
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button
            onClick={onSaveNotes}
            className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-sunken"
          >
            {t('lost_found.save_notes', { defaultValue: 'Guardar notas' })}
          </button>
          {showClose && (
            <button
              onClick={onClose}
              disabled={closing}
              className="rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
            >
              {closing
                ? t('lost_found.closing', { defaultValue: 'Cerrando…' })
                : t('lost_found.close_report', { defaultValue: 'Cerrar reporte' })}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
