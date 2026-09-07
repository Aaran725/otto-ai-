import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (house-stock-act.ts's real House STOCK Act PDF parsing) needs
  // its worker files excluded from Next's server bundling, or its own
  // dynamic worker resolution fails at runtime — confirmed live, this is
  // the exact fix pdf-parse's own troubleshooting docs give for Next.js.
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],
};

export default nextConfig;
