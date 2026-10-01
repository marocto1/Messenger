import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'apps', 'web', 'out');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'server', 'data'));
const internalPort = Number(process.env.INTERNAL_API_PORT || 4001);
const publicPort = Number(process.env.PORT || 3000);

fs.mkdirSync(dataDir, { recursive: true });
const keyFile = path.join(dataDir, '.security-master-key');
let securityKey = process.env.SECURITY_MASTER_KEY || '';
if (!securityKey) {
  if (fs.existsSync(keyFile)) securityKey = fs.readFileSync(keyFile, 'utf8').trim();
  if (!securityKey) {
    securityKey = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(keyFile, securityKey, { mode: 0o600 });
  }
}

const api = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(internalPort),
    DATA_DIR: dataDir,
    SECURITY_MASTER_KEY: securityKey,
    TRUST_PROXY: 'true',
    ALLOWED_ORIGIN: 'http://localhost',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
api.stdout.pipe(process.stdout);
api.stderr.pipe(process.stderr);
api.on('exit', (code) => {
  console.error(`[production] API exited with code ${code}`);
  process.exit(code ?? 1);
});

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function staticFileFor(urlPath) {
  let pathname = '/';
  try { pathname = decodeURIComponent(new URL(urlPath, 'http://local').pathname); } catch {}
  const candidates = [];
  if (pathname === '/') candidates.push(path.join(publicDir, 'index.html'));
  else {
    const clean = pathname.replace(/^\/+/, '');
    candidates.push(path.join(publicDir, clean));
    candidates.push(path.join(publicDir, clean, 'index.html'));
    if (!path.extname(clean)) candidates.push(path.join(publicDir, `${clean}.html`));
  }
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(path.resolve(publicDir) + path.sep) && resolved !== path.resolve(publicDir, 'index.html')) continue;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return null;
}

function serveStatic(req, res, file) {
  const ext = path.extname(file).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
  if (file.includes(`${path.sep}_next${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${internalPort}` };
  delete headers.origin;
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: internalPort,
    path: req.url,
    method: req.method,
    headers,
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (error) => {
    console.error('[production] proxy error', error);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'API_UNAVAILABLE' }));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const file = (req.method === 'GET' || req.method === 'HEAD') ? staticFileFor(req.url || '/') : null;
  if (file) return serveStatic(req, res, file);
  return proxyHttp(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: internalPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${internalPort}`, origin: undefined },
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    let response = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [name, value] of Object.entries(upRes.headers)) {
      if (value !== undefined) response += `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
    }
    response += '\r\n';
    socket.write(response);
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    socket.pipe(upSocket).pipe(socket);
  });
  upstream.on('response', (upRes) => {
    socket.write(`HTTP/1.1 ${upRes.statusCode || 502} ${upRes.statusMessage || ''}\r\n\r\n`);
    socket.destroy();
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

server.listen(publicPort, '0.0.0.0', () => {
  console.log(`[production] web + API listening on :${publicPort}; internal API :${internalPort}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  api.kill(signal);
  server.close(() => process.exit(0));
});
