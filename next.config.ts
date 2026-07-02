import type { NextConfig } from "next";

// ZAP PR13 fix (rules 10038/10020/10035/10021/10063/10037/90004,
// context/zap-reports/ZAP-PR13-fix-plan.md): no nonce/`proxy.ts` involvement
// needed since the app has no inline `<script>` — `script-src 'self'` is
// enough. `style-src` keeps `unsafe-inline` because `audit-log-table.tsx`
// sets a per-row inline `style` attribute for its category color swatch.
const isProd = process.env.NODE_ENV === "production";
// `next dev`'s React error-overlay needs `unsafe-eval` (Next's own CSP guide,
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md)
// — production/staging (what the ZAP scan targets) stays free of it.
const cspHeader = `
  default-src 'self';
  script-src 'self'${isProd ? "" : " 'unsafe-eval'"};
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  font-src 'self';
  connect-src 'self';
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  ${isProd ? "upgrade-insecure-requests;" : ""}
`
  .replace(/\s{2,}/g, " ")
  .trim();

const nextConfig: NextConfig = {
  // Allows dev-mode access (HMR + JS chunks) from the machine's Tailscale
  // address, not just localhost — without this, Next blocks those requests
  // cross-origin, the client bundle never loads, and the page silently never
  // hydrates (every form submit falls back to a native browser GET).
  allowedDevOrigins: ["100.68.190.22"],
  // um30: the Dockerfile's runner stage copies `.next/standalone`, which only
  // `next build` produces when this is set.
  output: "standalone",
  // ZAP PR13 fix, rule 10037: stop advertising the framework in responses.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: cspHeader },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
