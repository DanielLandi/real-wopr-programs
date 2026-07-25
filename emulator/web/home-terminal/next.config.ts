import type { NextConfig } from "next";

// Static export served by the VPS reverse proxy (deployment.md D1); crt-kit is
// consumed as raw TSX source, so Next transpiles it.
// WOPR_BASE_PATH lets the same app export for the public site's phone-book
// deployment (e.g. /real-wopr-site/terminal on GitHub Pages).
const nextConfig: NextConfig = {
  output: "export",
  basePath: process.env.WOPR_BASE_PATH || undefined,
  transpilePackages: ["@real-wopr/crt-kit"],
};

export default nextConfig;
