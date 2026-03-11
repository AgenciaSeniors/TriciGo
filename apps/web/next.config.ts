import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  transpilePackages: ['@tricigo/api', '@tricigo/types', '@tricigo/utils'],
};

export default withSentryConfig(nextConfig, {
  org: 'tricigo',
  project: 'tricigo-web',
  silent: !process.env.CI,
  widenClientFileUpload: true,
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
