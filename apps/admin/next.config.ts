import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@atlas/ui', '@atlas/types'],
  reactStrictMode: true,
};

export default nextConfig;
