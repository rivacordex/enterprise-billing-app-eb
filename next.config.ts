import type { NextConfig } from "next";

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
          // Content-Security-Policy is set per-request in proxy.ts — it
          // needs a fresh nonce every render, which a static header here
          // can't provide. Setting it in both places would send two CSP
          // headers, and browsers enforce the intersection of all of
          // them, silently re-blocking the nonce'd scripts.
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
