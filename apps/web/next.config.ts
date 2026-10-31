import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@atlas/ui', '@atlas/types'],
  reactStrictMode: true,
  // No need to tell every visitor which framework answered.
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Never let the app be framed (the dashboard holds resumes and an account-deletion button, a
        // clickjacking target), stop browsers guessing content types, and keep full addresses (job
        // and application ids) from leaving for other sites. Powerful browser features the app has
        // no use for are switched off. Pages only: the fingerprinted bundles under /_next/static keep
        // Next's own long-lived cache headers.
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
