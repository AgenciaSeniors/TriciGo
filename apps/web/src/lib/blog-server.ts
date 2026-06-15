import 'server-only';
import { createClient } from '@supabase/supabase-js';
import type { BlogPost } from '@tricigo/api';

// Server-side blog reads for the SSR blog pages. We deliberately build a fresh
// anon client here (same pattern as app/sitemap.ts) instead of reusing
// `blogService` from @tricigo/api: that service holds a browser-oriented
// singleton (`getSupabaseClient()`), whereas these run inside React Server
// Components / generateStaticParams. Every helper is best-effort — on missing
// env or a query error it returns an empty/null result so the build and ISR
// revalidation never crash (the page falls back to a not-found state).

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function getClient() {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return createClient(supabaseUrl, supabaseAnonKey);
}

export async function getPublishedPostsServer(limit = 50): Promise<BlogPost[]> {
  const supabase = getClient();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('*')
      .eq('is_published', true)
      .order('published_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []) as BlogPost[];
  } catch {
    return [];
  }
}

export async function getPostBySlugServer(slug: string): Promise<BlogPost | null> {
  const supabase = getClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('*')
      .eq('slug', slug)
      .eq('is_published', true)
      .maybeSingle();
    if (error) return null;
    return (data as BlogPost | null) ?? null;
  } catch {
    return null;
  }
}
