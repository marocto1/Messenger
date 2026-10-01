import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { root, runtimeEnv } from './runtime.mjs';
const mode = process.argv[2] || 'web';
const env = runtimeEnv();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = new Set();
function run(label, args) {
  const child = spawn(npm, args, { cwd: root, env, shell: process.platform === 'win32', detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => console.log(`[${label}] ${line}`));
  child.on('error', error => { console.error(`[${label}] ${error.message}`); stop(1); });
  return child;
}
function stop(code = 0) {
  if (stop.started) return; stop.started = true;
  for (const child of children) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  }
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required.');
if (!fs.existsSync(path.join(root, 'node_modules'))) {
  console.log('[SETUP] Installing locked dependencies. Cache and temporary files stay with the project.');
  const install = run('SETUP', ['ci']);
  await new Promise((resolve, reject) => install.on('exit', code => { children.delete(install); code ? reject(new Error('npm ci failed')) : resolve(); }));
}
if (['web', 'desktop'].includes(mode)) {
  for (const [example, target] of [['server/.env.example', 'server/.env'], ['apps/web/.env.example', 'apps/web/.env.local']]) if (!fs.existsSync(path.join(root, target))) fs.copyFileSync(path.join(root, example), path.join(root, target));
  const api = run('API', ['run', 'dev:server']); api.on('exit', code => { children.delete(api); stop(code || 0); });
  const client = run(mode.toUpperCase(), ['run', mode === 'desktop' ? 'dev:desktop' : 'dev:web']); client.on('exit', code => { children.delete(client); stop(code || 0); });
  console.log('[RUN] One console. Ctrl+C stops the API and client. Web: http://localhost:3000');
} else {
  const allowed = { 'build:desktop':'build:desktop', 'build:android':'build:android', 'release:android':'release:android', 'open:android':'open:android', 'prepare:android':'prepare:android' };
  if (!allowed[mode]) throw new Error('Unknown launcher mode.');
  const child = run('BUILD', ['run', allowed[mode]]); child.on('exit', code => { children.delete(child); process.exit(code || 0); });
}
