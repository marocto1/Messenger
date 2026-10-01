import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  output: 'export',
};

export default nextConfig;
