import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Generated projects live under ./generated and are built as standalone
  // Next apps. They must never be pulled into the control-panel compilation.
  outputFileTracingExcludes: {
    "*": ["./generated/**"],
  },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  experimental: {
    // The analyzer streams HTML/CSS and the AI layer returns large JSON
    // payloads; keep the control panel itself lean and predictable.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
