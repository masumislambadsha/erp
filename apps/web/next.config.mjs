import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // A self-contained server for the container image; the trace root is the repo so workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  // The browser talks to this origin only, so the httpOnly session cookie is first-party.
  async rewrites() {
    const api = process.env.API_URL ?? 'http://localhost:3001';
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
};
