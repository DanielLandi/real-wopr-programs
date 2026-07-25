import type { NextConfig } from "next";

// Static export served under /bigboard by the VPS reverse proxy (deployment.md D1/D3).
// trailingSlash: multi-route export (/, /tracks) as directory indexes.
const nextConfig: NextConfig = {
  output: "export",
  basePath: "/bigboard",
  trailingSlash: true,
  transpilePackages: ["@real-wopr/crt-kit"],
};

export default nextConfig;
