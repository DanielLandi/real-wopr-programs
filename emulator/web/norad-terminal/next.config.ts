import type { NextConfig } from "next";

// Static export served under /norad by the VPS reverse proxy (deployment.md D1/D3).
const nextConfig: NextConfig = {
  output: "export",
  basePath: "/norad",
  transpilePackages: ["@real-wopr/crt-kit"],
};

export default nextConfig;
