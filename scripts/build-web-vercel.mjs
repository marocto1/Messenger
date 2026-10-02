import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const webDir = path.join(root, 'apps', 'web');
const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');

const env = { ...process.env };
// Vercel injects NEXT_ADAPTER_PATH for Next.js 16.3 builds. Our app is a
// fully static export, and the plain Next build is the canonical artifact.
// Clear the adapter only for this child process so Vercel uses the same
// build path that is verified in CI and produces apps/web/out.
env.NEXT_ADAPTER_PATH = '';

const child = spawn(process.execPath, [nextBin, 'build'], {
  cwd: webDir,
  env,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`next build terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
