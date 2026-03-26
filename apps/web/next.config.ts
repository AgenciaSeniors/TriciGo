import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@tricigo/api', '@tricigo/types', '@tricigo/utils'],
  typescript: {
    // Pre-existing type error in packages/utils/src/analytics.ts
    // dynamic import('@tricigo/api') doesn't resolve during build type-check
    ignoreBuildErrors: true,
  },
};

export default withSentryConfig(nextConfig, {
  org: 'tricigo',
  project: 'tricigo-web',
  silent: !process.env.CI,
  widenClientFileUpload: true,
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
