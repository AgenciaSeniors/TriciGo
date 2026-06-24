import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

// Security headers applied to every admin route. The admin panel is an
// internal tool: deny framing (clickjacking), force HTTPS (HSTS), block
// MIME sniffing, and keep it out of search indexes.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Short max-age (1 day) so a transient TLS hiccup on a constrained network
  // (e.g. Cuba/Starlink) can't hard-lock a browser for years. Not on the HSTS
  // preload list, so no `preload`. Mirrors apps/web (PR #637).
  { key: 'Strict-Transport-Security', value: 'max-age=86400; includeSubDomains' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: [
    '@tricigo/api',
    '@tricigo/types',
    '@tricigo/theme',
    '@tricigo/i18n',
    '@tricigo/utils',
  ],
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};

export default withSentryConfig(nextConfig, {
  org: 'tricigo',
  project: 'tricigo-admin',
  silent: !process.env.CI,
  widenClientFileUpload: true,
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
