import { spawnSync } from 'node:child_process';
import { root, runtimeEnv, requireProductionEndpoints } from './runtime.mjs';
requireProductionEndpoints(process.env.NEXT_PUBLIC_API_URL, process.env.NEXT_PUBLIC_WS_URL);
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:web'], { cwd: root, env: runtimeEnv(), shell: process.platform === 'win32', stdio: 'inherit' });
process.exit(result.status || (result.error ? 1 : 0));
