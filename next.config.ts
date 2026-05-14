import type { NextConfig } from "next";

const securityHeaders = [
  // Force HTTPS for 2 years; include subdomains
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  // Disallow clickjacking
  { key: 'X-Frame-Options', value: 'DENY' },
  // Disable MIME-sniffing
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Don't leak the full URL when navigating away
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Restrict powerful browser APIs we don't use
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  // Modest CSP — Tailwind needs 'unsafe-inline' for runtime styles, Next.js needs
  // 'unsafe-eval' in dev. Permissive enough to not break the app, restrictive
  // enough to block obvious XSS payloads from loading external scripts.
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "img-src 'self' data: blob: https:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
