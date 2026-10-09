import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allows dev-mode access (HMR + JS chunks) from the machine's Tailscale and
  // ebill-dev-hub VPN addresses, not just localhost — without this, Next blocks
  // those requests cross-origin, the client bundle never loads, and the page
  // silently never hydrates (every form submit falls back to a native browser
  // GET). Sign-in from these origins also needs BETTER_AUTH_TRUSTED_ORIGINS.
  allowedDevOrigins: ["100.68.190.22", "172.16.0.2", "192.168.56.1"],
  // pm66 (rate card, RC15 / code-standards §6.34, D9): raise the Server Action
  // body limit from Next's 1 MB default. A ~5,400-row rate-card CSV is ~0.5 MB
  // and fits the default, but the day a card does not fit, this makes the
  // failure a VALIDATION MESSAGE (the upload action's typed FILE_TOO_LARGE
  // refusal) rather than a generic framework body-size error that reads as a
  // bug. This is a PLATFORM-OWNED root key edited by the rate card module —
  // called out in review (workflow §6.9), not folded silently.
  //
  // The limit is set ABOVE the action's own 4 MiB `MAX_UPLOAD_BYTES` on
  // purpose: `bodySizeLimit` bounds the WHOLE multipart request (file bytes +
  // boundaries + field headers + the cardName field), so setting it equal to
  // 4 MiB would let the multipart envelope of a 4 MiB file the action ACCEPTS
  // spill past the framework limit and be rejected as a generic body-size
  // error before FILE_TOO_LARGE can ever return — defeating the point of the
  // raise. 5 MiB leaves ~1 MiB of headroom for that overhead.
  //
  // Do NOT raise this further to "just accept bigger files": past roughly 50k
  // rows the schema is unchanged and the LOADER is what must change — a
  // streaming parse, a staging table, or a Kestra flow (RC15 revisit,
  // architecture §1). Read RC15 before touching this number.
  experimental: {
    serverActions: {
      bodySizeLimit: "5mb",
    },
  },
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
