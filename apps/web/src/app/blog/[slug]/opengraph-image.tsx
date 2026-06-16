import { ImageResponse } from 'next/og';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPostBySlugServer } from '@/lib/blog-server';

// Per-post Open Graph / Twitter share card. Mirrors the brand composition of
// the site-wide app/opengraph-image.tsx (deep navy + warm sunset glow + green
// accent + the real wordmark) but renders the POST TITLE, so every blog post
// shares with a branded, title-specific image — even the posts that have no
// cover_image_url. Generated in code with next/og (no manual PNGs).
export const runtime = 'nodejs';
export const alt = 'TriciGo — Blog';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const NAVY_BG = 'linear-gradient(135deg, #0a0e1a 0%, #0f172a 55%, #131c30 100%)';
const WARM_GLOW = 'radial-gradient(circle, rgba(249,115,22,0.32) 0%, rgba(234,88,12,0.12) 38%, rgba(15,23,42,0) 66%)';
const GREEN_GLOW = 'radial-gradient(circle, rgba(5,150,105,0.16) 0%, rgba(5,150,105,0) 64%)';
const ACCENT_BAR = 'linear-gradient(90deg, rgba(249,115,22,0) 0%, #f97316 50%, rgba(249,115,22,0) 100%)';
const TOP_EDGE = 'linear-gradient(90deg, #ea580c 0%, #f97316 45%, rgba(249,115,22,0) 100%)';

// Adaptive title size so short and long headlines both fill the card well.
function titleFontSize(title: string): number {
  const len = title.length;
  if (len <= 34) return 66;
  if (len <= 52) return 56;
  if (len <= 74) return 46;
  return 38;
}

export default async function BlogOgImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPostBySlugServer(slug);
  const title = post?.title_es ?? 'Blog de TriciGo';

  const logo = readFileSync(join(process.cwd(), 'public', 'logo-wordmark-white.png'));
  const logoSrc = `data:image/png;base64,${logo.toString('base64')}`;

  return new ImageResponse(
    (
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: NAVY_BG,
          overflow: 'hidden',
        }}
      >
        {/* Warm sunset glow (upper-right). */}
        <div style={{ position: 'absolute', top: -280, right: -120, width: 1000, height: 1000, background: WARM_GLOW }} />
        {/* Faint green depth glow (bottom-left). */}
        <div style={{ position: 'absolute', top: 300, left: -240, width: 760, height: 760, background: GREEN_GLOW }} />
        {/* Branded top edge. */}
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 8, background: TOP_EDGE }} />

        {/* Wordmark — top-left. */}
        <div style={{ display: 'flex', padding: '60px 72px 0' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} width={300} height={71} alt="TriciGo" />
        </div>

        {/* Title block — fills the middle, bottom-aligned. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            flex: 1,
            padding: '0 72px 60px',
            gap: 26,
          }}
        >
          <div style={{ width: 150, height: 5, borderRadius: 999, background: ACCENT_BAR }} />
          <div
            style={{
              display: 'flex',
              fontSize: titleFontSize(title),
              fontWeight: 800,
              color: '#f8fafc',
              lineHeight: 1.12,
              letterSpacing: -0.5,
              maxWidth: 1010,
            }}
          >
            {title}
          </div>
          <div style={{ display: 'flex', fontSize: 26, fontWeight: 500, color: '#94a3b8', letterSpacing: 1.5 }}>
            tricigo.com · Blog
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
