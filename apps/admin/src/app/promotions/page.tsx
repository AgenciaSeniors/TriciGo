'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ticket, Plus, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { promotionService, notificationService } from '@tricigo/api';
import type { Promotion, PromotionType } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { formatAdminDate } from '@/lib/formatDate';

type FormState = {
  code: string;
  type: PromotionType;
  discount_percent: number;
  discount_fixed_cup: number;
  max_uses: string;
  is_active: boolean;
  valid_from: string;
  valid_until: string;
  title_es: string;
  body_es: string;
  image_url: string;
  notify_on_publish: boolean;
};

const emptyForm: FormState = {
  code: '',
  type: 'percentage_discount',
  discount_percent: 10,
  discount_fixed_cup: 0,
  max_uses: '',
  is_active: false,
  valid_from: '',
  valid_until: '',
  title_es: '',
  body_es: '',
  image_url: '',
  notify_on_publish: true,
};

const PAGE_SIZE = 20;

function isoToInput(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 16);
}

function inputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function PromotionsAdminPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [items, setItems] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });
  const [deleteModalId, setDeleteModalId] = useState<string | null>(null);
  const [notifyTarget, setNotifyTarget] = useState<Promotion | null>(null);
  const [notifying, setNotifying] = useState(false);

  const typeLabel = useCallback(
    (type: PromotionType) =>
      type === 'percentage_discount'
        ? t('promotions.type_percentage', { defaultValue: 'Descuento %' })
        : type === 'fixed_discount'
          ? t('promotions.type_fixed', { defaultValue: 'Descuento fijo' })
          : t('promotions.type_bonus', { defaultValue: 'Bono crédito' }),
    [t],
  );

  const discountLabel = useCallback((p: Promotion) => {
    if (p.type === 'percentage_discount') return `${p.discount_percent ?? 0}%`;
    if (p.type === 'fixed_discount') return `−${p.discount_fixed_cup ?? 0} CUP`;
    return `+${p.discount_fixed_cup ?? 0} CUP`;
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await promotionService.getAll(page, PAGE_SIZE);
      setItems(data);
    } catch (err) {
      setItems([]);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, t]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  const resetForm = () => {
    setForm({ ...emptyForm });
    setEditingId(null);
    setShowForm(false);
  };

  // Fire the "notify on publish" push exactly once — only when the promo
  // is active, opted in, and not yet notified. Manual "Notificar ahora"
  // (handleNotify) handles re-sends and also stamps notified_at, so the
  // two paths can't double-fire.
  const maybeNotifyOnPublish = async (p: Promotion) => {
    if (!p.is_active || !p.notify_on_publish || p.notified_at) return;
    try {
      const { targeted } = await notificationService.broadcastToActiveUsers({
        title: p.title_es || p.code,
        body: p.body_es ?? '',
        contentType: 'promo',
        contentId: p.id,
      });
      await promotionService.update(p.id, { notified_at: new Date().toISOString() });
      showToast('success', t('promotions.toast_auto_notified', {
        defaultValue: 'Publicada y notificada a {{count}} usuarios',
        count: targeted,
      }));
    } catch {
      showToast('error', t('promotions.auto_notify_error', {
        defaultValue: 'Guardada, pero no se pudo enviar la notificación.',
      }));
    }
  };

  const handleSave = async () => {
    if (!form.code.trim()) {
      showToast('error', t('promotions.error_code_required', { defaultValue: 'El código es obligatorio' }));
      return;
    }
    try {
      const isPct = form.type === 'percentage_discount';
      const base = {
        code: form.code.trim().toUpperCase(),
        type: form.type,
        discount_percent: isPct ? Number(form.discount_percent) || 0 : null,
        discount_fixed_cup: isPct ? null : Number(form.discount_fixed_cup) || 0,
        max_uses: form.max_uses.trim() ? Number(form.max_uses) : null,
        is_active: form.is_active,
        valid_from: inputToIso(form.valid_from) ?? new Date().toISOString(),
        valid_until: inputToIso(form.valid_until),
        title_es: form.title_es.trim() || null,
        body_es: form.body_es.trim() || null,
        image_url: form.image_url.trim() || null,
        notify_on_publish: form.notify_on_publish,
      };
      if (editingId) {
        await promotionService.update(editingId, base);
        showToast('success', t('promotions.toast_updated', { defaultValue: 'Promoción actualizada' }));
        const prev = items.find((i) => i.id === editingId);
        await maybeNotifyOnPublish({
          ...(prev as Promotion),
          ...base,
          id: editingId,
          notified_at: prev?.notified_at ?? null,
        });
      } else {
        const created = await promotionService.create({ ...base, notified_at: null });
        showToast('success', t('promotions.toast_created', { defaultValue: 'Promoción creada' }));
        await maybeNotifyOnPublish(created);
      }
      resetForm();
      await loadItems();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    }
  };

  const handleEdit = (p: Promotion) => {
    setForm({
      code: p.code,
      type: p.type,
      discount_percent: p.discount_percent ?? 0,
      discount_fixed_cup: p.discount_fixed_cup ?? 0,
      max_uses: p.max_uses != null ? String(p.max_uses) : '',
      is_active: p.is_active,
      valid_from: isoToInput(p.valid_from),
      valid_until: isoToInput(p.valid_until),
      title_es: p.title_es ?? '',
      body_es: p.body_es ?? '',
      image_url: p.image_url ?? '',
      notify_on_publish: p.notify_on_publish,
    });
    setEditingId(p.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await promotionService.remove(id);
      showToast('success', t('promotions.toast_deleted', { defaultValue: 'Promoción eliminada' }));
      await loadItems();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    }
  };

  const handleNotify = async (p: Promotion) => {
    setNotifying(true);
    try {
      const { targeted } = await notificationService.broadcastToActiveUsers({
        title: p.title_es || p.code,
        body: p.body_es ?? '',
        contentType: 'promo',
        contentId: p.id,
      });
      // Stamp notified_at so the auto "notify on publish" path won't
      // double-fire a promo that was already manually notified.
      await promotionService.update(p.id, { notified_at: new Date().toISOString() });
      showToast(
        'success',
        targeted > 0
          ? t('promotions.toast_notified', {
              defaultValue: 'Notificación enviada a {{count}} usuarios',
              count: targeted,
            })
          : t('promotions.toast_notified_none', {
              defaultValue: 'No hay usuarios activos con notificaciones habilitadas.',
            }),
      );
      setNotifyTarget(null);
    } catch (err) {
      showToast(
        'error',
        err instanceof Error
          ? err.message
          : t('promotions.notify_error', { defaultValue: 'No pudimos enviar la notificación.' }),
      );
    } finally {
      setNotifying(false);
    }
  };

  const handleToggleActive = async (p: Promotion) => {
    try {
      await promotionService.setActive(p.id, !p.is_active);
      showToast('success', p.is_active
        ? t('promotions.toast_deactivated', { defaultValue: 'Promoción desactivada' })
        : t('promotions.toast_activated', { defaultValue: 'Promoción activada' }),
      );
      // Activating (was inactive) is a "publish" event → maybe auto-notify.
      if (!p.is_active) await maybeNotifyOnPublish({ ...p, is_active: true });
      await loadItems();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    }
  };

  const sortedItems = useMemo(() => {
    if (!sort) return items;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.columnId as keyof Promotion;
    return [...items].sort((a, b) => {
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [items, sort]);

  const columns: DataColumn<Promotion>[] = useMemo(
    () => [
      {
        id: 'code',
        header: t('promotions.col_code', { defaultValue: 'Código' }),
        cell: (p) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono font-medium text-ink">{p.code}</span>
            {p.title_es && <span className="truncate text-[11px] text-ink-muted">{p.title_es}</span>}
          </span>
        ),
        primary: true,
        sortKey: 'code',
      },
      {
        id: 'type',
        header: t('promotions.col_type', { defaultValue: 'Tipo' }),
        cell: (p) => (
          <span className="flex min-w-0 flex-col">
            <span className="text-ink">{typeLabel(p.type)}</span>
            <span className="font-mono text-[11px] text-ink-muted">{discountLabel(p)}</span>
          </span>
        ),
        hideBelow: 'md',
      },
      {
        id: 'is_active',
        header: t('promotions.col_status', { defaultValue: 'Estado' }),
        cell: (p) =>
          p.is_active ? (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              {t('promotions.status_active', { defaultValue: 'Activa' })}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
              {t('promotions.status_inactive', { defaultValue: 'Inactiva' })}
            </span>
          ),
        width: '110px',
      },
      {
        id: 'uses',
        header: t('promotions.col_uses', { defaultValue: 'Usos' }),
        cell: (p) => (
          <span className="font-mono text-ink-muted">
            {p.current_uses}
            {p.max_uses != null ? ` / ${p.max_uses}` : ''}
          </span>
        ),
        width: '90px',
        hideBelow: 'lg',
      },
      {
        id: 'valid',
        header: t('promotions.col_valid', { defaultValue: 'Vigencia' }),
        cell: (p) => (
          <span className="text-[11px] text-ink-muted">
            {p.valid_from ? formatAdminDate(p.valid_from) : '—'}
            <span className="mx-1 text-ink-subtle">→</span>
            {p.valid_until ? formatAdminDate(p.valid_until) : '∞'}
          </span>
        ),
        hideBelow: 'lg',
      },
      {
        id: 'created_at',
        header: t('promotions.col_created', { defaultValue: 'Creada' }),
        cell: (p) => <span className="text-ink-muted">{formatAdminDate(p.created_at)}</span>,
        hideBelow: 'lg',
        sortKey: 'created_at',
        width: '170px',
      },
    ],
    [t, typeLabel, discountLabel],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('promotions.page_eyebrow', { defaultValue: 'Crecimiento · códigos promo' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('promotions.title', { defaultValue: 'Promociones' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('promotions.page_description', { defaultValue: 'Códigos de descuento y bonos. Activá una para avisar a todos por push.' })}
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => {
              resetForm();
              setShowForm(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('promotions.new', { defaultValue: 'Nueva promoción' })}
          </button>
        )}
      </div>

      {showForm && (
        <div className="admin-card p-5 animate-fade-in">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
              {editingId
                ? t('promotions.editing', { defaultValue: 'Editando promoción' })
                : t('promotions.new', { defaultValue: 'Nueva promoción' })}
            </p>
            <button
              onClick={resetForm}
              className="rounded-md p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink"
              aria-label={t('promotions.close', { defaultValue: 'Cerrar' })}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label={t('promotions.field_code', { defaultValue: 'Código' })}>
              <input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="BIENVENIDA20"
                className={`${inputCls} font-mono uppercase`}
              />
            </Field>
            <Field label={t('promotions.field_type', { defaultValue: 'Tipo' })}>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as PromotionType })}
                className={inputCls}
              >
                <option value="percentage_discount">{t('promotions.type_percentage', { defaultValue: 'Descuento %' })}</option>
                <option value="fixed_discount">{t('promotions.type_fixed', { defaultValue: 'Descuento fijo' })}</option>
                <option value="bonus_credit">{t('promotions.type_bonus', { defaultValue: 'Bono crédito' })}</option>
              </select>
            </Field>
            {form.type === 'percentage_discount' ? (
              <Field label={t('promotions.field_discount_pct', { defaultValue: 'Descuento (%)' })}>
                <input
                  type="number"
                  value={form.discount_percent}
                  onChange={(e) => setForm({ ...form, discount_percent: Number(e.target.value) })}
                  className={inputCls}
                />
              </Field>
            ) : (
              <Field label={t('promotions.field_discount_cup', { defaultValue: 'Monto (CUP)' })}>
                <input
                  type="number"
                  value={form.discount_fixed_cup}
                  onChange={(e) => setForm({ ...form, discount_fixed_cup: Number(e.target.value) })}
                  className={inputCls}
                />
              </Field>
            )}
            <Field label={t('promotions.field_max_uses', { defaultValue: 'Usos máximos (vacío = sin límite)' })}>
              <input
                type="number"
                value={form.max_uses}
                onChange={(e) => setForm({ ...form, max_uses: e.target.value })}
                placeholder="∞"
                className={inputCls}
              />
            </Field>
            <Field label={t('promotions.field_valid_from', { defaultValue: 'Vigente desde' })}>
              <input
                type="datetime-local"
                value={form.valid_from}
                onChange={(e) => setForm({ ...form, valid_from: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label={t('promotions.field_valid_until', { defaultValue: 'Vigente hasta (opcional)' })}>
              <input
                type="datetime-local"
                value={form.valid_until}
                onChange={(e) => setForm({ ...form, valid_until: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label={t('promotions.field_push_title', { defaultValue: 'Título del aviso (push)' })}>
              <input
                value={form.title_es}
                onChange={(e) => setForm({ ...form, title_es: e.target.value })}
                placeholder={t('promotions.placeholder_push_title', { defaultValue: '¡20% en tu próximo viaje!' })}
                className={inputCls}
              />
            </Field>
            <Field label={t('promotions.field_push_body', { defaultValue: 'Cuerpo del aviso (push)' })}>
              <textarea
                rows={2}
                value={form.body_es}
                onChange={(e) => setForm({ ...form, body_es: e.target.value })}
                placeholder={t('promotions.placeholder_push_body', { defaultValue: 'Usá el código BIENVENIDA20 antes del domingo.' })}
                className={textareaCls}
              />
            </Field>
            <Field label={t('promotions.field_image', { defaultValue: 'Imagen (URL, opcional)' })}>
              <input
                value={form.image_url}
                onChange={(e) => setForm({ ...form, image_url: e.target.value })}
                placeholder="https://…"
                className={inputCls}
              />
            </Field>
            <Field label={t('promotions.field_active', { defaultValue: 'Activa' })}>
              <label className="inline-flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  className="h-4 w-4 rounded border-line"
                />
                {t('promotions.active_help', { defaultValue: 'El código se puede canjear' })}
              </label>
            </Field>
            <Field label={t('promotions.field_notify_on_publish', { defaultValue: 'Notificar al publicar' })}>
              <label className="inline-flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={form.notify_on_publish}
                  onChange={(e) => setForm({ ...form, notify_on_publish: e.target.checked })}
                  className="h-4 w-4 rounded border-line"
                />
                {t('promotions.notify_on_publish_help', { defaultValue: 'Envía un push a todos al activarla (una sola vez)' })}
              </label>
            </Field>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={resetForm}
              className="rounded-full border border-line bg-surface px-4 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-sunken"
            >
              {t('promotions.cancel', { defaultValue: 'Cancelar' })}
            </button>
            <button
              onClick={() => void handleSave()}
              className="rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90"
            >
              {t('promotions.save', { defaultValue: 'Guardar' })}
            </button>
          </div>
        </div>
      )}

      <DataTable<Promotion>
        columns={columns}
        rows={sortedItems}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void loadItems()}
        empty={{
          icon: Ticket,
          title: t('promotions.empty_title', { defaultValue: 'Sin promociones' }),
          body: t('promotions.empty_body', { defaultValue: 'Creá la primera para ofrecer un descuento y avisar a todos.' }),
          action: {
            label: t('promotions.new', { defaultValue: 'Nueva promoción' }),
            onClick: () => {
              resetForm();
              setShowForm(true);
            },
          },
        }}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: items.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
        rowActions={[
          { label: t('promotions.action_edit', { defaultValue: 'Editar' }), onClick: (p) => handleEdit(p) },
          {
            label: t('promotions.action_toggle', { defaultValue: 'Activar/Desactivar' }),
            onClick: (p) => void handleToggleActive(p),
          },
          {
            label: t('promotions.action_notify', { defaultValue: 'Notificar ahora' }),
            onClick: (p) => setNotifyTarget(p),
          },
          {
            label: t('promotions.action_delete', { defaultValue: 'Eliminar' }),
            tone: 'danger',
            onClick: (p) => setDeleteModalId(p.id),
          },
        ]}
      />

      <AdminConfirmModal
        open={!!deleteModalId}
        title={t('promotions.delete_title', { defaultValue: 'Eliminar promoción' })}
        message={t('promotions.delete_confirm', { defaultValue: 'Esta acción no se puede deshacer.' })}
        variant="danger"
        onConfirm={async () => {
          if (deleteModalId) {
            await handleDelete(deleteModalId);
            setDeleteModalId(null);
          }
        }}
        onCancel={() => setDeleteModalId(null)}
      />

      <AdminConfirmModal
        open={!!notifyTarget}
        title={t('promotions.notify_title', { defaultValue: 'Enviar notificación push' })}
        message={
          notifyTarget
            ? t('promotions.notify_confirm', {
                defaultValue:
                  'Se enviará una notificación a todos los usuarios activos en los últimos 30 días con notificaciones habilitadas.\n\nTítulo: "{{title}}"\nCuerpo: "{{body}}"',
                title: notifyTarget.title_es || notifyTarget.code,
                body: notifyTarget.body_es ?? '(sin cuerpo)',
              })
            : ''
        }
        confirmLabel={
          notifying
            ? t('promotions.notifying', { defaultValue: 'Enviando…' })
            : t('promotions.notify_confirm_btn', { defaultValue: 'Enviar' })
        }
        onConfirm={async () => {
          if (notifyTarget && !notifying) {
            await handleNotify(notifyTarget);
          }
        }}
        onCancel={() => {
          if (!notifying) setNotifyTarget(null);
        }}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  'h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none';
const textareaCls =
  'rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none';
