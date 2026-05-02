'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Newspaper, Plus, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { blogService, notificationService } from '@tricigo/api';
import type { BlogPost } from '@tricigo/api';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { formatAdminDate } from '@/lib/formatDate';

const emptyForm = {
  slug: '',
  title_es: '',
  title_en: '',
  excerpt_es: '',
  excerpt_en: '',
  body_es: '',
  body_en: '',
  cover_image_url: '',
  is_published: false,
  published_at: null as string | null,
  author_id: null as string | null,
};

const PAGE_SIZE = 20;

export default function BlogAdminPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });
  const [deleteModalId, setDeleteModalId] = useState<string | null>(null);
  // ID of the post currently queued for a "Notificar ahora" push.
  // null = no modal open. We hold the full row so the confirmation
  // modal can preview the title before sending to thousands of users.
  const [notifyTarget, setNotifyTarget] = useState<BlogPost | null>(null);
  const [notifying, setNotifying] = useState(false);

  const loadPosts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await blogService.getAllPosts(page, PAGE_SIZE);
      setPosts(data);
    } catch (err) {
      setPosts([]);
      setError(err instanceof Error ? err.message : t('blog.load_error', { defaultValue: 'No pudimos cargar los posts.' }));
    } finally {
      setLoading(false);
    }
  }, [page, t]);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  const resetForm = () => {
    setForm({ ...emptyForm });
    setEditingId(null);
    setShowForm(false);
  };

  const handleSave = async () => {
    try {
      if (editingId) {
        await blogService.updatePost(editingId, {
          slug: form.slug,
          title_es: form.title_es,
          title_en: form.title_en,
          excerpt_es: form.excerpt_es,
          excerpt_en: form.excerpt_en,
          body_es: form.body_es,
          body_en: form.body_en,
          cover_image_url: form.cover_image_url || null,
        });
        showToast('success', t('blog.toast_updated', { defaultValue: 'Post actualizado' }));
      } else {
        await blogService.createPost({
          slug: form.slug,
          title_es: form.title_es,
          title_en: form.title_en,
          excerpt_es: form.excerpt_es,
          excerpt_en: form.excerpt_en,
          body_es: form.body_es,
          body_en: form.body_en,
          cover_image_url: form.cover_image_url || null,
          is_published: false,
          published_at: null,
          author_id: null,
        });
        showToast('success', t('blog.toast_created', { defaultValue: 'Post creado' }));
      }
      resetForm();
      await loadPosts();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('blog.save_error', { defaultValue: 'No pudimos guardar el post.' }));
    }
  };

  const handleEdit = (post: BlogPost) => {
    setForm({
      slug: post.slug,
      title_es: post.title_es,
      title_en: post.title_en,
      excerpt_es: post.excerpt_es,
      excerpt_en: post.excerpt_en,
      body_es: post.body_es,
      body_en: post.body_en,
      cover_image_url: post.cover_image_url ?? '',
      is_published: post.is_published,
      published_at: post.published_at,
      author_id: post.author_id,
    });
    setEditingId(post.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await blogService.deletePost(id);
      showToast('success', t('blog.toast_deleted', { defaultValue: 'Post eliminado' }));
      await loadPosts();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('blog.delete_error', { defaultValue: 'No pudimos eliminar el post.' }));
    }
  };

  const handleNotify = async (post: BlogPost) => {
    setNotifying(true);
    try {
      const { targeted } = await notificationService.broadcastToActiveUsers({
        title: post.title_es || post.title_en || '(sin título)',
        body: post.excerpt_es || post.excerpt_en || '',
        contentType: 'blog',
        contentId: post.id,
      });
      showToast(
        'success',
        targeted > 0
          ? t('blog.toast_notified', {
              defaultValue: 'Notificación enviada a {{count}} usuarios',
              count: targeted,
            })
          : t('blog.toast_notified_none', {
              defaultValue: 'No hay usuarios activos con notificaciones habilitadas.',
            }),
      );
      setNotifyTarget(null);
    } catch (err) {
      showToast(
        'error',
        err instanceof Error
          ? err.message
          : t('blog.notify_error', { defaultValue: 'No pudimos enviar la notificación.' }),
      );
    } finally {
      setNotifying(false);
    }
  };

  const handleTogglePublish = async (post: BlogPost) => {
    try {
      if (post.is_published) {
        await blogService.unpublishPost(post.id);
        showToast('success', t('blog.toast_unpublished', { defaultValue: 'Post despublicado' }));
      } else {
        await blogService.publishPost(post.id);
        showToast('success', t('blog.toast_published', { defaultValue: 'Post publicado' }));
      }
      await loadPosts();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('blog.publish_error', { defaultValue: 'No pudimos cambiar el estado.' }));
    }
  };

  const sortedPosts = useMemo(() => {
    if (!sort) return posts;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.columnId as keyof BlogPost;
    return [...posts].sort((a, b) => {
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [posts, sort]);

  const columns: DataColumn<BlogPost>[] = useMemo(
    () => [
      {
        id: 'title_es',
        header: t('blog.col_title', { defaultValue: 'Título' }),
        cell: (p) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-ink">
              {p.title_es || p.title_en || t('blog.no_title', { defaultValue: '(sin título)' })}
            </span>
            <span className="truncate font-mono text-[11px] text-ink-muted">{p.slug}</span>
          </span>
        ),
        primary: true,
        sortKey: 'title_es',
      },
      {
        id: 'is_published',
        header: t('blog.col_status', { defaultValue: 'Estado' }),
        cell: (p) =>
          p.is_published ? (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              {t('blog.status_published', { defaultValue: 'Publicado' })}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
              {t('blog.status_draft', { defaultValue: 'Borrador' })}
            </span>
          ),
        width: '120px',
      },
      {
        id: 'excerpt_es',
        header: t('blog.col_excerpt', { defaultValue: 'Resumen' }),
        cell: (p) => (
          <span className="block max-w-[280px] truncate text-ink-muted">
            {p.excerpt_es || <span className="text-ink-subtle">—</span>}
          </span>
        ),
        hideBelow: 'lg',
        secondary: true,
      },
      {
        id: 'created_at',
        header: t('blog.col_created', { defaultValue: 'Creado' }),
        cell: (p) => <span className="text-ink-muted">{formatAdminDate(p.created_at)}</span>,
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
            {t('blog.page_eyebrow', { defaultValue: 'Contenido · bitácora' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('blog.title', { defaultValue: 'Blog' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('blog.page_description', { defaultValue: 'Historias, novedades y anuncios que se publican en la web pública.' })}
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
            {t('blog.new_post', { defaultValue: 'Nuevo post' })}
          </button>
        )}
      </div>

      {showForm && (
        <div className="admin-card p-5 animate-fade-in">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
              {editingId
                ? t('blog.editing_post', { defaultValue: 'Editando post' })
                : t('blog.new_post', { defaultValue: 'Nuevo post' })}
            </p>
            <button
              onClick={resetForm}
              className="rounded-md p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink"
              aria-label={t('blog.close', { defaultValue: 'Cerrar' })}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label={t('blog.field_slug', { defaultValue: 'Slug' })}>
              <input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                placeholder={t('blog.placeholder_slug', { defaultValue: 'nota-sobre-la-habana' })}
                className={inputCls}
              />
            </Field>
            <Field label={t('blog.field_cover', { defaultValue: 'Imagen de portada' })}>
              <input
                value={form.cover_image_url}
                onChange={(e) => setForm({ ...form, cover_image_url: e.target.value })}
                placeholder="https://…"
                className={inputCls}
              />
            </Field>
            <Field label={t('blog.field_title_es', { defaultValue: 'Título (ES)' })}>
              <input
                value={form.title_es}
                onChange={(e) => setForm({ ...form, title_es: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label={t('blog.field_title_en', { defaultValue: 'Title (EN)' })}>
              <input
                value={form.title_en}
                onChange={(e) => setForm({ ...form, title_en: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label={t('blog.field_excerpt_es', { defaultValue: 'Resumen (ES)' })}>
              <input
                value={form.excerpt_es}
                onChange={(e) => setForm({ ...form, excerpt_es: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label={t('blog.field_excerpt_en', { defaultValue: 'Excerpt (EN)' })}>
              <input
                value={form.excerpt_en}
                onChange={(e) => setForm({ ...form, excerpt_en: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label={t('blog.field_body_es', { defaultValue: 'Cuerpo (ES)' })}>
              <textarea
                rows={8}
                value={form.body_es}
                onChange={(e) => setForm({ ...form, body_es: e.target.value })}
                className={textareaCls}
              />
            </Field>
            <Field label={t('blog.field_body_en', { defaultValue: 'Body (EN)' })}>
              <textarea
                rows={8}
                value={form.body_en}
                onChange={(e) => setForm({ ...form, body_en: e.target.value })}
                className={textareaCls}
              />
            </Field>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={resetForm}
              className="rounded-full border border-line bg-surface px-4 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-sunken"
            >
              {t('blog.cancel', { defaultValue: 'Cancelar' })}
            </button>
            <button
              onClick={() => void handleSave()}
              className="rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90"
            >
              {t('blog.save', { defaultValue: 'Guardar' })}
            </button>
          </div>
        </div>
      )}

      <DataTable<BlogPost>
        columns={columns}
        rows={sortedPosts}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void loadPosts()}
        empty={{
          icon: Newspaper,
          title: t('blog.empty_title', { defaultValue: 'Sin posts' }),
          body: t('blog.empty_body', { defaultValue: 'Creá el primero para que la bitácora cuente la historia de TriciGo.' }),
          action: {
            label: t('blog.new_post', { defaultValue: 'Nuevo post' }),
            onClick: () => {
              resetForm();
              setShowForm(true);
            },
          },
        }}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: posts.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
        rowActions={[
          { label: t('blog.action_edit', { defaultValue: 'Editar' }), onClick: (p) => handleEdit(p) },
          {
            label: t('blog.action_toggle_publish', { defaultValue: 'Publicar/Despublicar' }),
            onClick: (p) => void handleTogglePublish(p),
          },
          {
            label: t('blog.action_notify', { defaultValue: 'Notificar ahora' }),
            onClick: (p) => setNotifyTarget(p),
          },
          {
            label: t('blog.action_delete', { defaultValue: 'Eliminar' }),
            tone: 'danger',
            onClick: (p) => setDeleteModalId(p.id),
          },
        ]}
      />

      <AdminConfirmModal
        open={!!deleteModalId}
        title={t('blog.delete_title', { defaultValue: 'Eliminar post' })}
        message={t('blog.delete_confirm', { defaultValue: 'Esta acción no se puede deshacer.' })}
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
        title={t('blog.notify_title', { defaultValue: 'Enviar notificación push' })}
        message={
          notifyTarget
            ? t('blog.notify_confirm', {
                defaultValue:
                  'Se enviará una notificación a todos los usuarios activos en los últimos 30 días con notificaciones habilitadas.\n\nTítulo: "{{title}}"\nResumen: "{{excerpt}}"',
                title: notifyTarget.title_es || notifyTarget.title_en || '(sin título)',
                excerpt: notifyTarget.excerpt_es || notifyTarget.excerpt_en || '(sin resumen)',
              })
            : ''
        }
        confirmLabel={
          notifying
            ? t('blog.notifying', { defaultValue: 'Enviando…' })
            : t('blog.notify_confirm_btn', { defaultValue: 'Enviar' })
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
