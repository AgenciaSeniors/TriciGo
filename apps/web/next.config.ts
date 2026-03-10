import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@tricigo/api', '@tricigo/types', '@tricigo/utils'],
};

export default nextConfig;
