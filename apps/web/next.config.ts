import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@tricigo/api', '@tricigo/types'],
};

export default nextConfig;
