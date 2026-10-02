import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  ...(process.env.VERCEL ? {} : { output: 'export' as const }),
};

export default nextConfig;
