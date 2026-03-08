import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@tricigo/api',
    '@tricigo/types',
    '@tricigo/theme',
    '@tricigo/i18n',
    '@tricigo/utils',
  ],
};

export default nextConfig;
