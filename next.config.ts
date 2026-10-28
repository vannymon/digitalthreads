import type { NextConfig } from "next";

// GitHub Pages serves a static site from /<repo>/, so the Pages build sets
// STATIC_EXPORT and BASE_PATH. Locally neither is set and `next start` works
// as before.
const nextConfig: NextConfig = {
  ...(process.env.STATIC_EXPORT && { output: "export" }),
  basePath: process.env.BASE_PATH || undefined,
  images: { unoptimized: true },
};

export default nextConfig;
