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

  async updateContent(
    slug: string,
    updates: Partial<Pick<CmsContent, 'title_es' | 'title_en' | 'body_es' | 'body_en'>>,
    adminId: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('cms_content')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
        updated_by: adminId,
      })
      .eq('slug', slug);
    if (error) throw error;

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: 'update_cms_content',
      target_type: 'cms_content',
      target_id: slug,
    });
  },
};
