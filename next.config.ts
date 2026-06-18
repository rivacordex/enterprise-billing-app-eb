import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allows dev-mode access (HMR + JS chunks) from the machine's Tailscale
  // address, not just localhost — without this, Next blocks those requests
  // cross-origin, the client bundle never loads, and the page silently never
  // hydrates (every form submit falls back to a native browser GET).
  allowedDevOrigins: ["100.68.190.22"],
};

export default nextConfig;
