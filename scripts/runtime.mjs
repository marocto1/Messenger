import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function runtimeEnv(base = process.env) {
  const runtime = path.join(root, '.runtime');
  const dirs = { npm_config_cache: 'npm-cache', TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp', CARGO_HOME: 'cargo', CARGO_TARGET_DIR: 'cargo-target', GRADLE_USER_HOME: 'gradle' };
  const env = { ...base };
  for (const [key, suffix] of Object.entries(dirs)) { env[key] = base[key] || path.join(runtime, suffix); fs.mkdirSync(env[key], { recursive: true }); }
  return env;
}
export function loadEnvFile(file, env = process.env) {
  if (!fs.existsSync(file)) return env;
  for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) if (env[key] === undefined) env[key] = value;
  return env;
}
function parseEnv(text) {
  // Node's parser handles quotes and comments without executing shell code.
  return process.getBuiltinModule('node:util').parseEnv(text);
}
export function requireProductionEndpoints(api, ws) {
  if (!api || !ws) throw new Error('Set NEXT_PUBLIC_API_URL=https://api.your-domain and NEXT_PUBLIC_WS_URL=wss://api.your-domain/ws before a production native build.');
  for (const [value, protocol] of [[api, 'https:'], [ws, 'wss:']]) {
    const url = new URL(value);
    if (url.protocol !== protocol || /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/.test(url.hostname) || url.hostname === '[::1]' || url.username || url.password) throw new Error(`Production endpoint must be public ${protocol}: ${url.origin}`);
  }
}
