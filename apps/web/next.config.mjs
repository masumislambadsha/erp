/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The browser talks to this origin only, so the httpOnly session cookie is first-party.
  async rewrites() {
    const api = process.env.API_URL ?? 'http://localhost:3001';
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
};
