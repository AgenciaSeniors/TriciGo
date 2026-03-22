'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { cmsService, type CmsContent } from '@tricigo/api/services/cms';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';

export default function ContentPage() {
  const { t } = useTranslation('admin');
  const [contents, setContents] = useState<CmsContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CmsContent | null>(null);
  const [saving, setSaving] = useState(false);

  // Edit form state
  const [titleEs, setTitleEs] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [bodyEs, setBodyEs] = useState('');
  const [bodyEn, setBodyEn] = useState('');

  useEffect(() => {
    loadContent();
  }, []);

  const loadContent = async () => {
    try {
      const data = await cmsService.getAllContent();
      setContents(data);
    } catch (err) {
      console.error('Error loading CMS content:', err);
    } finally {
      setLoading(false);
    }
  };

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
      await cmsService.updateContent(editing.slug, {
        title_es: titleEs,
        title_en: titleEn,
        body_es: bodyEs,
        body_en: bodyEn,
      }, 'admin');
      setEditing(null);
      loadContent();
    } catch (err) {
      console.error('Error saving content:', err);
    } finally {
      setSaving(false);
    }
  };

  const slugLabels: Record<string, string> = {
    terms: t('content.terms', { defaultValue: 'Terminos y Condiciones' }),
    privacy: t('content.privacy', { defaultValue: 'Politica de Privacidad' }),
    faq: t('content.faq', { defaultValue: 'Preguntas Frecuentes' }),
  };

  if (editing) {
    return (
      <div className="max-w-4xl">
        <div className="flex items-center gap-4 mb-6">
          <button
            onClick={() => setEditing(null)}
            className="text-sm text-neutral-500 hover:text-neutral-700"
          >
            &larr; {t('common.back_to_list')}
          </button>
        </div>
        <h1 className="text-3xl font-bold mb-6">
          {t('content.editing', { defaultValue: 'Editando' })}: {slugLabels[editing.slug] ?? editing.slug}
        </h1>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Spanish */}
          <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
            <h3 className="text-sm font-bold text-neutral-700 mb-3">Espanol</h3>
            <div className="mb-4">
              <label className="block text-xs font-medium text-neutral-500 mb-1">
                {t('content.title', { defaultValue: 'Titulo' })}
              </label>
              <input
                type="text"
                value={titleEs}
                onChange={(e) => setTitleEs(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-500 mb-1">
                {t('content.body', { defaultValue: 'Contenido (Markdown)' })}
              </label>
              <textarea
                value={bodyEs}
                onChange={(e) => setBodyEs(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 font-mono"
                rows={16}
              />
            </div>
          </div>

          {/* English */}
          <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
            <h3 className="text-sm font-bold text-neutral-700 mb-3">English</h3>
            <div className="mb-4">
              <label className="block text-xs font-medium text-neutral-500 mb-1">Title</label>
              <input
                type="text"
                value={titleEn}
                onChange={(e) => setTitleEn(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-500 mb-1">Content (Markdown)</label>
              <textarea
                value={bodyEn}
                onChange={(e) => setBodyEn(e.target.value)}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 font-mono"
                rows={16}
              />
            </div>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={() => setEditing(null)}
            className="px-4 py-2 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-100"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-3xl font-bold mb-8">{t('content.title_page', { defaultValue: 'Contenido CMS' })}</h1>

      {loading ? (
        <AdminTableSkeleton rows={5} columns={3} />
      ) : (
        <div className="space-y-4">
          {contents.map((item) => (
            <div key={item.id} className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 flex items-center justify-between">
              <div>
                <h3 className="font-bold">{slugLabels[item.slug] ?? item.slug}</h3>
                <p className="text-sm text-neutral-500 mt-1">
                  {t('content.last_updated', { defaultValue: 'Ultima actualizacion' })}: {new Date(item.updated_at).toLocaleDateString('es-CU')}
                </p>
              </div>
              <button
                onClick={() => startEdit(item)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600"
              >
                {t('common.edit')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
