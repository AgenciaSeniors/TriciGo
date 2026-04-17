'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, FileText } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { useToast } from '@/components/ui/AdminToast';
import { cmsService, type CmsContent } from '@tricigo/api/services/cms';
import { DataEmptyState } from '@/components/data/DataEmptyState';
import { formatAdminDate } from '@/lib/formatDate';

export default function ContentPage() {
  const { t } = useTranslation('admin');
  const slugMeta = (slug: string): { title: string; subtitle: string } => {
    const fallbacks: Record<string, { title: string; subtitle: string }> = {
      terms: { title: 'Términos y Condiciones', subtitle: 'Base legal del servicio' },
      privacy: { title: 'Política de Privacidad', subtitle: 'Cómo manejamos los datos' },
      faq: { title: 'Preguntas Frecuentes', subtitle: 'Dudas comunes de usuarios' },
    };
    return {
      title: t(`content.slug_${slug}_title`, { defaultValue: fallbacks[slug]?.title ?? slug }),
      subtitle: t(`content.slug_${slug}_subtitle`, { defaultValue: fallbacks[slug]?.subtitle ?? '' }),
    };
  };
  const { showToast } = useToast();
  const [contents, setContents] = useState<CmsContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CmsContent | null>(null);
  const [saving, setSaving] = useState(false);

  const [titleEs, setTitleEs] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [bodyEs, setBodyEs] = useState('');
  const [bodyEn, setBodyEn] = useState('');

  const loadContent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await cmsService.getAllContent();
      setContents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('content.load_error', { defaultValue: 'No pudimos cargar el contenido.' }));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadContent();
  }, [loadContent]);

  const startEdit = (item: CmsContent) => {
    setEditing(item);
    setTitleEs(item.title_es);
    setTitleEn(item.title_en);
    setBodyEs(item.body_es);
    setBodyEn(item.body_en);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await cmsService.updateContent(
        editing.slug,
        { title_es: titleEs, title_en: titleEn, body_es: bodyEs, body_en: bodyEn },
        'admin',
      );
      setEditing(null);
      await loadContent();
      showToast('success', t('content.toast_saved', { defaultValue: 'Contenido guardado' }));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('content.save_error', { defaultValue: 'No pudimos guardar el contenido.' }));
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    const meta = slugMeta(editing.slug);
    return (
      <div className="flex flex-col gap-5">
        <div>
          <button
            onClick={() => setEditing(null)}
            className="mb-2 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-muted hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('content.back_to_list', { defaultValue: 'Volver a la lista' })}
          </button>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('content.editing_eyebrow', { defaultValue: 'Contenido · editando' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {meta.title}
          </h1>
          {meta.subtitle && (
            <p className="mt-0.5 text-[12.5px] text-ink-muted">{meta.subtitle}</p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <section className="admin-card p-5">
            <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
              {t('content.lang_es', { defaultValue: 'Español' })}
            </p>
            <label className="mb-3 flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('content.field_title_es', { defaultValue: 'Título' })}
              </span>
              <input
                value={titleEs}
                onChange={(e) => setTitleEs(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('content.field_body_es', { defaultValue: 'Contenido (Markdown)' })}
              </span>
              <textarea
                rows={18}
                value={bodyEs}
                onChange={(e) => setBodyEs(e.target.value)}
                className="rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
          </section>

          <section className="admin-card p-5">
            <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
              {t('content.lang_en', { defaultValue: 'English' })}
            </p>
            <label className="mb-3 flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('content.field_title_en', { defaultValue: 'Title' })}
              </span>
              <input
                value={titleEn}
                onChange={(e) => setTitleEn(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('content.field_body_en', { defaultValue: 'Content (Markdown)' })}
              </span>
              <textarea
                rows={18}
                value={bodyEn}
                onChange={(e) => setBodyEn(e.target.value)}
                className="rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
              />
            </label>
          </section>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={() => setEditing(null)}
            className="rounded-full border border-line bg-surface px-4 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-sunken"
          >
            {t('content.cancel', { defaultValue: 'Cancelar' })}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded-full bg-ink px-4 py-1.5 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving
              ? t('content.saving', { defaultValue: 'Guardando…' })
              : t('content.save_changes', { defaultValue: 'Guardar cambios' })}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('content.page_eyebrow', { defaultValue: 'Contenido · CMS' })}
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          {t('content.title', { defaultValue: 'Páginas legales y FAQ' })}
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          {t('content.page_description', { defaultValue: 'Textos oficiales que ven pasajeros y conductores en la app. Editá en español e inglés.' })}
        </p>
      </div>

      {loading && (
        <div className="admin-card p-8">
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-surface-sunken" />
            ))}
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="admin-card p-8">
          <DataEmptyState
            icon={FileText}
            tone="danger"
            title={t('content.error_title', { defaultValue: 'No pudimos cargar el contenido' })}
            body={error}
            action={{ label: t('content.retry', { defaultValue: 'Reintentar' }), onClick: () => void loadContent() }}
          />
        </div>
      )}

      {!loading && !error && contents.length === 0 && (
        <div className="admin-card p-8">
          <DataEmptyState
            icon={FileText}
            title={t('content.empty_title', { defaultValue: 'Sin contenido registrado' })}
            body={t('content.empty_body', { defaultValue: 'Todavía no hay entradas CMS. Creá los primeros textos legales.' })}
          />
        </div>
      )}

      {!loading && !error && contents.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {contents.map((item) => {
            const meta = slugMeta(item.slug);
            return (
              <article
                key={item.id}
                className="admin-card flex flex-col gap-3 p-5 transition-colors hover:bg-surface-sunken/40"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-500/10 text-primary-500">
                    <FileText className="h-4 w-4" strokeWidth={1.8} />
                  </span>
                  <div className="flex-1">
                    <h2 className="font-display text-[15px] font-semibold text-ink">{meta.title}</h2>
                    <p className="text-[11.5px] text-ink-muted">{meta.subtitle || item.slug}</p>
                  </div>
                </div>
                <div className="flex flex-col gap-1 rounded-xl bg-surface-sunken p-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                    {t('content.last_update', { defaultValue: 'Última actualización' })}
                  </span>
                  <span className="text-[12.5px] text-ink">{formatAdminDate(item.updated_at)}</span>
                </div>
                <button
                  onClick={() => startEdit(item)}
                  className="inline-flex items-center justify-center rounded-full bg-ink px-4 py-1.5 text-[12px] font-medium text-surface transition-opacity hover:opacity-90"
                >
                  {t('content.edit', { defaultValue: 'Editar' })}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
