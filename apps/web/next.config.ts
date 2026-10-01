import type { NextConfig } from 'next';

const isGitHubPages = process.env.GITHUB_PAGES === 'true';
const repoBasePath = isGitHubPages ? '/Messenger' : '';

const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  output: 'export',
  basePath: repoBasePath,
  assetPrefix: repoBasePath || undefined,
};

export default nextConfig;
