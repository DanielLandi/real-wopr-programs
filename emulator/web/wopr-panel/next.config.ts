import type { NextConfig } from "next";

// Static export served under /panel by the VPS reverse proxy (deployment.md D1/D3).
const nextConfig: NextConfig = {
  output: "export",
  basePath: "/panel",
  transpilePackages: ["@real-wopr/crt-kit"],
};

export default nextConfig;
