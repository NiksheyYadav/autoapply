import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@atlas/ui', '@atlas/types'],
  reactStrictMode: true,
  async headers() {
    return [
      {
        // The console shows student personal data. Keep its pages out of shared
        // and browser caches, never let it be framed, and never send its
        // address (which carries an organization id) to another site.
        // Pages only: the fingerprinted bundles under /_next/static keep Next's own long-lived cache headers.
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
