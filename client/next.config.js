/** @type {import('next').NextConfig} */
const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Proxy /api/* and /uploads/* to the Express server during development
    // so the browser sees a single origin (no CORS dance).
    return [
      { source: '/api/:path*', destination: `${API}/api/:path*` },
      { source: '/uploads/:path*', destination: `${API}/uploads/:path*` },
      { source: '/selfies/:path*', destination: `${API}/selfies/:path*` },
    ];
  },
  images: {
    remotePatterns: [{ protocol: 'http', hostname: 'localhost' }],
  },
};

module.exports = nextConfig;
