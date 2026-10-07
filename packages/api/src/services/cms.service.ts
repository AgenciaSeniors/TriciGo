import { getSupabaseClient } from '../client';

export interface CmsContent {
  id: string;
  slug: string;
  title_es: string;
  title_en: string;
  body_es: string;
  body_en: string;
  updated_at: string;
  updated_by: string | null;
}

export const cmsService = {
  async getContent(slug: string): Promise<CmsContent | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('cms_content')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw error;
    return data as CmsContent | null;
  },

  async getAllContent(): Promise<CmsContent[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('cms_content')
      .select('*')
      .order('slug');
    if (error) throw error;
    return (data ?? []) as CmsContent[];
  },

  /**
   * Admin-only. The editor is the signed-in admin, taken from the session:
   * cms_content.updated_by and admin_actions.admin_id are uuids, and the
   * panel used to pass the string 'admin', so every save failed (22P02).
   */
  async updateContent(
    slug: string,
    updates: Partial<Pick<CmsContent, 'title_es' | 'title_en' | 'body_es' | 'body_en'>>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { data: { user: admin } } = await supabase.auth.getUser();
    if (!admin) throw new Error('Admin not authenticated');

    const { data, error } = await supabase
      .from('cms_content')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
        updated_by: admin.id,
      })
      .eq('slug', slug)
      .select('slug');
    if (error) throw error;
    // RLS hides the row from a non-admin and PostgREST answers OK with 0 rows.
    if (!data || data.length === 0) throw new Error('No se guardó el contenido: tu cuenta no tiene permisos de administrador.');

    await supabase.from('admin_actions').insert({
      admin_id: admin.id,
      action: 'update_cms_content',
      target_type: 'cms_content',
      target_id: slug,
    });
  },
};
