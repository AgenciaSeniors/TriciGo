import type { MetadataRoute } from 'next';
import { createClient } from '@supabase/supabase-js';
import { getAllProvinceSlugs } from '@/lib/coverage';
import { getAllCityParams } from '@/lib/cities';
import { AIRPORT, getAllRouteSlugs } from '@/lib/airport-routes';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = 'https://tricigo.com';

  // Static pages
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: new Date(), changeFrequency: 'weekly', priority: 1.0 },
    { url: `${baseUrl}/book`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.9 },
    { url: `${baseUrl}/blog`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.7 },
    { url: `${baseUrl}/empresas`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${baseUrl}/support`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.5 },
    { url: `${baseUrl}/login`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.5 },
    { url: `${baseUrl}/privacy`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
    { url: `${baseUrl}/terms`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
    { url: `${baseUrl}/refunds`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
    { url: `${baseUrl}/contact`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
    { url: `${baseUrl}/aml`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
    { url: `${baseUrl}/cookies`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
  ];

  // Local-SEO coverage hub + one page per province
  const coverageRoutes: MetadataRoute.Sitemap = [
    { url: `${baseUrl}/transporte`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
    ...getAllProvinceSlugs().map((slug) => ({
      url: `${baseUrl}/transporte/${slug}`,
      lastModified: new Date(),
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
    ...getAllCityParams().map(({ provincia, ciudad }) => ({
      url: `${baseUrl}/transporte/${provincia}/${ciudad}`,
      lastModified: new Date(),
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
  ];

  // Airport transfer routes (hub + one page per destination)
  const airportRoutes: MetadataRoute.Sitemap = [
    { url: `${baseUrl}${AIRPORT.hubPath}`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.6 },
    ...getAllRouteSlugs().map((slug) => ({
      url: `${baseUrl}${AIRPORT.hubPath}/${slug}`,
      lastModified: new Date(),
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
  ];

  // Dynamic blog posts
  let blogRoutes: MetadataRoute.Sitemap = [];
  try {
    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    const { data: posts } = await supabase
      .from('blog_posts')
      .select('slug, updated_at')
      .eq('is_published', true)
      .order('published_at', { ascending: false })
      .limit(100);

    if (posts) {
      blogRoutes = posts.map((post) => ({
        url: `${baseUrl}/blog/${post.slug}`,
        lastModified: new Date(post.updated_at),
        changeFrequency: 'monthly' as const,
        priority: 0.6,
      }));
    }
  } catch {
    // Best-effort: if blog posts fetch fails, just use static routes
  }

  return [...staticRoutes, ...coverageRoutes, ...airportRoutes, ...blogRoutes];
}
