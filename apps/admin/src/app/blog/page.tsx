'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { blogService } from '@tricigo/api';
import type { BlogPost } from '@tricigo/api';

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

export default function BlogAdminPage() {
  const { t } = useTranslation('admin');
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });

  const loadPosts = () => {
    setLoading(true);
    blogService
      .getAllPosts(0, 100)
      .then(setPosts)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadPosts();
  }, []);

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
      }
      resetForm();
      loadPosts();
    } catch (err) {
      console.error(err);
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
    if (!confirm(t('blog.confirm_delete'))) return;
    try {
      await blogService.deletePost(id);
      loadPosts();
    } catch (err) {
      console.error(err);
    }
  };

  const handleTogglePublish = async (post: BlogPost) => {
    try {
      if (post.is_published) {
        await blogService.unpublishPost(post.id);
      } else {
        await blogService.publishPost(post.id);
      }
      loadPosts();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('blog.title')}</h1>
        {!showForm && (
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="bg-primary-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-600"
          >
            {t('blog.new_post')}
          </button>
        )}
      </div>

      {showForm && (
        <div className="bg-white border border-neutral-200 rounded-xl p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('blog.slug')}</label>
              <input
                type="text"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-sm"
                placeholder="my-post-slug"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('blog.cover_image')}</label>
              <input
                type="text"
                value={form.cover_image_url}
                onChange={(e) => setForm({ ...form, cover_image_url: e.target.value })}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-sm"
                placeholder="https://..."
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Title (ES)</label>
              <input
                type="text"
                value={form.title_es}
                onChange={(e) => setForm({ ...form, title_es: e.target.value })}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Title (EN)</label>
              <input
                type="text"
                value={form.title_en}
                onChange={(e) => setForm({ ...form, title_en: e.target.value })}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('blog.excerpt')} (ES)</label>
              <input
                type="text"
                value={form.excerpt_es}
                onChange={(e) => setForm({ ...form, excerpt_es: e.target.value })}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('blog.excerpt')} (EN)</label>
              <input
                type="text"
                value={form.excerpt_en}
                onChange={(e) => setForm({ ...form, excerpt_en: e.target.value })}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('blog.body')} (ES)</label>
              <textarea
                value={form.body_es}
                onChange={(e) => setForm({ ...form, body_es: e.target.value })}
                rows={6}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('blog.body')} (EN)</label>
              <textarea
                value={form.body_en}
                onChange={(e) => setForm({ ...form, body_en: e.target.value })}
                rows={6}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              className="bg-primary-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-600"
            >
              {t('blog.save')}
            </button>
            <button
              onClick={resetForm}
              className="border border-neutral-300 text-neutral-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-neutral-50"
            >
              {t('blog.cancel')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-neutral-500">{t('common.loading')}</p>
      ) : (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Title</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">{t('blog.slug')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">{t('common.date')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {posts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-neutral-400">
                    {t('blog.no_posts', 'No posts yet')}
                  </td>
                </tr>
              ) : (
                posts.map((post) => (
                  <tr key={post.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-3 font-medium">{post.title_en || post.title_es}</td>
                    <td className="px-4 py-3 text-neutral-500">{post.slug}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                          post.is_published
                            ? 'bg-green-100 text-green-700'
                            : 'bg-neutral-100 text-neutral-600'
                        }`}
                      >
                        {post.is_published ? t('blog.published') : t('blog.draft')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {new Date(post.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleEdit(post)}
                          className="text-primary-500 hover:underline text-xs font-medium"
                        >
                          {t('blog.edit')}
                        </button>
                        <button
                          onClick={() => handleTogglePublish(post)}
                          className="text-amber-600 hover:underline text-xs font-medium"
                        >
                          {post.is_published ? t('blog.unpublish') : t('blog.publish')}
                        </button>
                        <button
                          onClick={() => handleDelete(post.id)}
                          className="text-red-500 hover:underline text-xs font-medium"
                        >
                          {t('blog.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
