import path from "node:path";
import type { NextConfig } from "next";

// Static export served by the VPS reverse proxy (deployment.md D1); crt-kit and
// the shared terminal package are consumed as raw TSX/TS source, so Next
// transpiles them.
// WOPR_BASE_PATH lets the same app export for the public site's phone-book
// deployment (e.g. /real-wopr-site/terminal on GitHub Pages).
const nextConfig: NextConfig = {
  output: "export",
  basePath: process.env.WOPR_BASE_PATH || undefined,
  transpilePackages: ["@real-wopr/crt-kit", "@real-wopr/terminal"],
  // Turbopack infers its root from the nearest lockfile — emulator/web — which
  // leaves emulator/terminal outside the resolvable tree and fails its import
  // as a bare "module not found". Widen the root to emulator/ (#108 §4).
  turbopack: { root: path.join(import.meta.dirname, "../..") },
};

export default nextConfig;
