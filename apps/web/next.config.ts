import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

// Content-Security-Policy for the public web app, built from its actual
// external origins:
//   - Mapbox GL: maps, vector tiles (fetched via XHR -> connect-src), and
//     web workers loaded from blob: URLs.
//   - Supabase: REST + Storage (https) and Realtime (wss).
//   - Sentry: browser error ingest (*.sentry.io).
//   - Nominatim: address fallback fetched directly in AddressAutocomplete.
//   - Stripe: libs are still bundled, so its script/frame/connect origins
//     are allowed defensively.
// 'unsafe-inline'/'unsafe-eval' are required by Next.js hydration + Mapbox;
// the protection here is (a) restricting WHICH origins may load scripts /
// be connected to, and (b) frame-ancestors (anti-clickjacking), object-src,
// base-uri and form-action. img-src allows any https so map tiles from
// rotating tile subdomains keep loading.
//
// NOTE: a CSP can only be fully validated in a browser. If a legitimate
// resource is blocked after deploy, add its origin here (or temporarily
// switch the header key to `Content-Security-Policy-Report-Only`).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://*.mapbox.com https://js.stripe.com",
  "worker-src 'self' blob:",
  "child-src 'self' blob: https://js.stripe.com",
  "style-src 'self' 'unsafe-inline' https://api.mapbox.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.mapbox.com https://nominatim.openstreetmap.org https://*.sentry.io https://api.stripe.com",
  "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
  "manifest-src 'self'",
  "media-src 'self'",
  "upgrade-insecure-requests",
].join('; ');

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@tricigo/api', '@tricigo/types', '@tricigo/utils'],
  // isomorphic-dompurify pulls in jsdom on the server (used to sanitize blog
  // post bodies during SSR). Keep it external so Next bundles it as a plain
  // node_modules require instead of trying to trace jsdom's dynamic requires.
  serverExternalPackages: ['isomorphic-dompurify'],
  typescript: {
    // Pre-existing type error in packages/utils/src/analytics.ts
    // dynamic import('@tricigo/api') doesn't resolve during build type-check
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: 'tricigo.com' },
    ],
  },
  async redirects() {
    return [
      // Old indexed slug. The renamed post it pointed to is now unpublished
      // (region-neutral pass), so redirect to the blog index instead of 404ing.
      {
        source: '/blog/para-que-no-te-claven-precio-taxi-cuba',
        destination: '/blog',
        permanent: true,
      },
      // The SMS that tells a package recipient to follow their delivery pointed
      // at /delivery/<share_token>, a route that never existed — the recipient
      // got a 404. Migration 00513 changes the trigger to emit /track/share/,
      // which is the page that actually renders the delivery. This redirect
      // covers any message already in the wild and any copy still carrying the
      // old shape.
      {
        source: '/delivery/:token',
        destination: '/track/share/:token',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          // Force HTTPS (incl. subdomains), but keep the max-age short (1 day) so a
          // transient TLS hiccup on a constrained network (e.g. Cuba/Starlink) can't
          // hard-lock a browser for years. Domain is not on the HSTS preload list, so
          // no `preload`. Also limit powerful browser features to what the app uses.
          { key: 'Strict-Transport-Security', value: 'max-age=86400; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
          { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
        ],
      },
      {
        source: '/blog/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' },
        ],
      },
      {
        source: '/(rides|wallet|profile|notifications)(.*)',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      // BUG-202: Android Digital Asset Links + iOS Universal Links files
      // must be served with the correct Content-Type for autoVerify to work.
      // Files live at apps/web/public/.well-known/{assetlinks.json,apple-app-site-association}.
      {
        source: '/.well-known/assetlinks.json',
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Cache-Control', value: 'public, max-age=3600' },
        ],
      },
      {
        source: '/.well-known/apple-app-site-association',
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Cache-Control', value: 'public, max-age=3600' },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: 'tricigo',
  project: 'tricigo-web',
  silent: !process.env.CI,
  widenClientFileUpload: true,
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
