'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, Plus, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { announcementService, notificationService } from '@tricigo/api';
import type { HomeAnnouncement } from '@tricigo/api';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { formatAdminDate } from '@/lib/formatDate';

type FormState = {
  title_es: string;
  body_es: string;
  image_url: string;
  cta_label_es: string;
  cta_url: string;
  is_active: boolean;
  starts_at: string;
  ends_at: string;
  priority: number;
};

const emptyForm: FormState = {
  title_es: '',
  body_es: '',
  image_url: '',
  cta_label_es: '',
  cta_url: '',
  is_active: false,
  starts_at: '',
  ends_at: '',
  priority: 0,
};

const PAGE_SIZE = 20;

function isoToInput(iso: string | null): string {
  if (!iso) return '';
  // Convert "2026-05-01T11:11:19+00:00" -> "2026-05-01T11:11" (datetime-local)
  return iso.slice(0, 16);
}

function inputToIso(value: string): string | null {
  if (!value) return null;
  // datetime-local has no timezone, treat as local; Date will serialize to UTC.
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function AnnouncementsAdminPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [items, setItems] = useState<HomeAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });
  const [deleteModalId, setDeleteModalId] = useState<string | null>(null);
  // ID of the announcement currently queued for a "Notificar ahora" push.
  // null = no modal open. We hold the full row so the confirmation modal
  // can preview the title/body before sending to thousands of users.
  const [notifyTarget, setNotifyTarget] = useState<HomeAnnouncement | null>(null);
  const [notifying, setNotifying] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await announcementService.getAll(page, PAGE_SIZE);
      setItems(data);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : t('announcements.load_error', { defaultValue: 'No pudimos cargar los anuncios.' }));
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

  const handleSave = async () => {
    if (!form.title_es.trim()) {
      showToast('error', t('announcements.error_title_required', { defaultValue: 'El título es obligatorio' }));
      return;
    }
    try {
      const payload = {
        title_es: form.title_es.trim(),
        body_es: form.body_es.trim() || null,
        image_url: form.image_url.trim() || null,
        cta_label_es: form.cta_label_es.trim() || null,
        cta_url: form.cta_url.trim() || null,
        is_active: form.is_active,
        starts_at: inputToIso(form.starts_at),
        ends_at: inputToIso(form.ends_at),
        city_id: null,
        priority: Number.isFinite(form.priority) ? form.priority : 0,
      };
      if (editingId) {
        await announcementService.update(editingId, payload);
        showToast('success', t('announcements.toast_updated', { defaultValue: 'Anuncio actualizado' }));
      } else {
        await announcementService.create(payload);
        showToast('success', t('announcements.toast_created', { defaultValue: 'Anuncio creado' }));
      }
      resetForm();
      await loadItems();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('announcements.save_error', { defaultValue: 'No pudimos guardar el anuncio.' }));
    }
  };

  const handleEdit = (a: HomeAnnouncement) => {
    setForm({
      title_es: a.title_es,
      body_es: a.body_es ?? '',
      image_url: a.image_url ?? '',
      cta_label_es: a.cta_label_es ?? '',
      cta_url: a.cta_url ?? '',
      is_active: a.is_active,
      starts_at: isoToInput(a.starts_at),
      ends_at: isoToInput(a.ends_at),
      priority: a.priority,
    });
    setEditingId(a.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await announcementService.remove(id);
      showToast('success', t('announcements.toast_deleted', { defaultValue: 'Anuncio eliminado' }));
      await loadItems();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('announcements.delete_error', { defaultValue: 'No pudimos eliminar el anuncio.' }));
    }
  };

  const handleNotify = async (a: HomeAnnouncement) => {
    setNotifying(true);
    try {
      const { targeted } = await notificationService.broadcastToActiveUsers({
        title: a.title_es,
        body: a.body_es ?? '',
        contentType: 'announcement',
        contentId: a.id,
      });
      showToast(
        'success',
        targeted > 0
          ? t('announcements.toast_notified', {
              defaultValue: 'Notificación enviada a {{count}} usuarios',
              count: targeted,
            })
          : t('announcements.toast_notified_none', {
              defaultValue: 'No hay usuarios activos con notificaciones habilitadas.',
            }),
      );
      setNotifyTarget(null);
    } catch (err) {
      showToast(
        'error',
        err instanceof Error
          ? err.message
          : t('announcements.notify_error', { defaultValue: 'No pudimos enviar la notificación.' }),
      );
    } finally {
      setNotifying(false);
    }
  };

  const handleToggleActive = async (a: HomeAnnouncement) => {
    try {
      await announcementService.setActive(a.id, !a.is_active);
      showToast('success', a.is_active
        ? t('announcements.toast_deactivated', { defaultValue: 'Anuncio desactivado' })
        : t('announcements.toast_activated', { defaultValue: 'Anuncio activado' }),
      );
      await loadItems();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('announcements.toggle_error', { defaultValue: 'No pudimos cambiar el estado.' }));
    }
  };

  const sortedItems = useMemo(() => {
    if (!sort) return items;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.columnId as keyof HomeAnnouncement;
    return [...items].sort((a, b) => {
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [items, sort]);

  const columns: DataColumn<HomeAnnouncement>[] = useMemo(
    () => [
      {
        id: 'title_es',
        header: t('announcements.col_title', { defaultValue: 'Título' }),
        cell: (a) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-ink">
              {a.title_es || t('announcements.no_title', { defaultValue: '(sin título)' })}
            </span>
            {a.cta_url && (
              <span className="truncate font-mono text-[11px] text-ink-muted">{a.cta_url}</span>
            )}
          </span>
        ),
        primary: true,
        sortKey: 'title_es',
      },
      {
        id: 'is_active',
        header: t('announcements.col_status', { defaultValue: 'Estado' }),
        cell: (a) =>
          a.is_active ? (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              {t('announcements.status_active', { defaultValue: 'Activo' })}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
              {t('announcements.status_inactive', { defaultValue: 'Inactivo' })}
            </span>
          ),
        width: '120px',
      },
      {
        id: 'priority',
        header: t('announcements.col_priority', { defaultValue: 'Prioridad' }),
        cell: (a) => <span className="font-mono text-ink-muted">{a.priority}</span>,
        width: '100px',
        sortKey: 'priority',
        hideBelow: 'md',
      },
      {
        id: 'window',
        header: t('announcements.col_window', { defaultValue: 'Ventana' }),
        cell: (a) => (
          <span className="text-[11px] text-ink-muted">
            {a.starts_at ? formatAdminDate(a.starts_at) : '—'}
            <span className="mx-1 text-ink-subtle">→</span>
            {a.ends_at ? formatAdminDate(a.ends_at) : '∞'}
          </span>
        ),
        hideBelow: 'lg',
      },
      {
        id: 'created_at',
        header: t('announcements.col_created', { defaultValue: 'Creado' }),
        cell: (a) => <span className="text-ink-muted">{formatAdminDate(a.created_at)}</span>,
        hideBelow: 'lg',
        sortKey: 'created_at',
        width: '170px',
      },
    ],
    [t],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('announcements.page_eyebrow', { defaultValue: 'Contenido · home cards' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('announcements.title', { defaultValue: 'Anuncios' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('announcements.page_description', { defaultValue: 'Cards destacadas que aparecen en el home del cliente entre Promos y Novedades.' })}
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
            {t('announcements.new', { defaultValue: 'Nuevo anuncio' })}
          </button>
        )}
      </div>

      {showForm && (
        <div className="admin-card p-5 animate-fade-in">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
              {editingId
                ? t('announcements.editing', { defaultValue: 'Editando anuncio' })
                : t('announcements.new', { defaultValue: 'Nuevo anuncio' })}
            </p>
            <button
              onClick={resetForm}
              className="rounded-md p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink"
              aria-label={t('announcements.close', { defaultValue: 'Cerrar' })}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label={t('announcements.field_title', { defaultValue: 'Título' })}>
              <input
                value={form.title_es}
                onChange={(e) => setForm({ ...form, title_es: e.target.value })}
                placeholder={t('announcements.placeholder_title', { defaultValue: 'Carnaval de La Habana' })}
                className={inputCls}
              />
            </Field>
            <Field label={t('announcements.field_image', { defaultValue: 'Imagen (URL)' })}>
              <input
                value={form.image_url}
                onChange={(e) => setForm({ ...form, image_url: e.target.value })}
                placeholder="https://…"
                className={inputCls}
              />
            </Field>
            <Field label={t('announcements.field_body', { defaultValue: 'Cuerpo' })}>
              <textarea
                rows={3}
                value={form.body_es}
                onChange={(e) => setForm({ ...form, body_es: e.target.value })}
                placeholder={t('announcements.placeholder_body', { defaultValue: 'Tarifa especial todo el fin de semana…' })}
                className={textareaCls}
              />
            </Field>
            <Field label={t('announcements.field_cta_label', { defaultValue: 'Etiqueta del botón' })}>
              <input
                value={form.cta_label_es}
                onChange={(e) => setForm({ ...form, cta_label_es: e.target.value })}
                placeholder={t('announcements.placeholder_cta_label', { defaultValue: 'Ver más' })}
                className={inputCls}
              />
            </Field>
            <Field label={t('announcements.field_cta_url', { defaultValue: 'URL del botón' })}>
              <input
                value={form.cta_url}
                onChange={(e) => setForm({ ...form, cta_url: e.target.value })}
                placeholder={t('announcements.placeholder_cta_url', { defaultValue: '/promo/codigo o https://…' })}
                className={inputCls}
              />
            </Field>
            <Field label={t('announcements.field_priority', { defaultValue: 'Prioridad (mayor = primero)' })}>
              <input
                type="number"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                className={inputCls}
              />
            </Field>
            <Field label={t('announcements.field_starts', { defaultValue: 'Inicio (opcional)' })}>
              <input
                type="datetime-local"
                value={form.starts_at}
                onChange={(e) => setForm({ ...form, starts_at: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label={t('announcements.field_ends', { defaultValue: 'Fin (opcional)' })}>
              <input
                type="datetime-local"
                value={form.ends_at}
                onChange={(e) => setForm({ ...form, ends_at: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label={t('announcements.field_active', { defaultValue: 'Activo' })}>
              <label className="inline-flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  className="h-4 w-4 rounded border-line"
                />
                {t('announcements.active_help', { defaultValue: 'Visible en el home' })}
              </label>
            </Field>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={resetForm}
              className="rounded-full border border-line bg-surface px-4 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-sunken"
            >
              {t('announcements.cancel', { defaultValue: 'Cancelar' })}
            </button>
            <button
              onClick={() => void handleSave()}
              className="rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90"
            >
              {t('announcements.save', { defaultValue: 'Guardar' })}
            </button>
          </div>
        </div>
      )}

      <DataTable<HomeAnnouncement>
        columns={columns}
        rows={sortedItems}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void loadItems()}
        empty={{
          icon: Megaphone,
          title: t('announcements.empty_title', { defaultValue: 'Sin anuncios' }),
          body: t('announcements.empty_body', { defaultValue: 'Creá el primero para destacarlo en el home del cliente.' }),
          action: {
            label: t('announcements.new', { defaultValue: 'Nuevo anuncio' }),
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
          { label: t('announcements.action_edit', { defaultValue: 'Editar' }), onClick: (a) => handleEdit(a) },
          {
            label: t('announcements.action_toggle', { defaultValue: 'Activar/Desactivar' }),
            onClick: (a) => void handleToggleActive(a),
          },
          {
            label: t('announcements.action_notify', { defaultValue: 'Notificar ahora' }),
            onClick: (a) => setNotifyTarget(a),
          },
          {
            label: t('announcements.action_delete', { defaultValue: 'Eliminar' }),
            tone: 'danger',
            onClick: (a) => setDeleteModalId(a.id),
          },
        ]}
      />

      <AdminConfirmModal
        open={!!deleteModalId}
        title={t('announcements.delete_title', { defaultValue: 'Eliminar anuncio' })}
        message={t('announcements.delete_confirm', { defaultValue: 'Esta acción no se puede deshacer.' })}
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
        title={t('announcements.notify_title', { defaultValue: 'Enviar notificación push' })}
        message={
          notifyTarget
            ? t('announcements.notify_confirm', {
                defaultValue:
                  'Se enviará una notificación a todos los usuarios activos en los últimos 30 días con notificaciones habilitadas.\n\nTítulo: "{{title}}"\nCuerpo: "{{body}}"',
                title: notifyTarget.title_es,
                body: notifyTarget.body_es ?? '(sin cuerpo)',
              })
            : ''
        }
        confirmLabel={
          notifying
            ? t('announcements.notifying', { defaultValue: 'Enviando…' })
            : t('announcements.notify_confirm_btn', { defaultValue: 'Enviar' })
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
