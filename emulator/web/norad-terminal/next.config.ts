import path from "node:path";
import type { NextConfig } from "next";

// Static export served under /norad by the VPS reverse proxy (deployment.md D1/D3).
const nextConfig: NextConfig = {
  output: "export",
  basePath: "/norad",
  transpilePackages: ["@real-wopr/crt-kit", "@real-wopr/terminal"],
  // Turbopack infers its root from the nearest lockfile — emulator/web — which
  // leaves emulator/terminal outside the resolvable tree and fails its import
  // as a bare "module not found". Widen the root to emulator/ (#108 §4).
  turbopack: { root: path.join(import.meta.dirname, "../..") },
};

export default nextConfig;
