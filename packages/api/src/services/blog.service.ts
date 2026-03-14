import { getSupabaseClient } from '../client';

export interface BlogPost {
  id: string;
  slug: string;
  title_es: string;
  title_en: string;
  excerpt_es: string;
  excerpt_en: string;
  body_es: string;
  body_en: string;
  cover_image_url: string | null;
  is_published: boolean;
  published_at: string | null;
  author_id: string | null;
  created_at: string;
  updated_at: string;
}

export const blogService = {
  async getPublishedPosts(page = 0, pageSize = 10): Promise<BlogPost[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('blog_posts')
      .select('*')
      .eq('is_published', true)
      .order('published_at', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    return (data ?? []) as BlogPost[];
  },

  async getPostBySlug(slug: string): Promise<BlogPost | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('blog_posts')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw error;
    return data as BlogPost | null;
  },

  async getAllPosts(page = 0, pageSize = 20): Promise<BlogPost[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('blog_posts')
      .select('*')
      .order('created_at', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    return (data ?? []) as BlogPost[];
  },

  async createPost(post: Omit<BlogPost, 'id' | 'created_at' | 'updated_at'>): Promise<BlogPost> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('blog_posts')
      .insert(post)
      .select()
      .single();
    if (error) throw error;
    return data as BlogPost;
  },

  async updatePost(id: string, updates: Partial<BlogPost>): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('blog_posts')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  async deletePost(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('blog_posts')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },

  async publishPost(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('blog_posts')
      .update({
        is_published: true,
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw error;
  },

  async unpublishPost(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('blog_posts')
      .update({
        is_published: false,
        published_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw error;
  },
};
