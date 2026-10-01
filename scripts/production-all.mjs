import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const staticRoot = path.join(projectRoot, 'apps', 'web', 'out');
const publicPort = Number(process.env.PORT || 3000);
const apiPort = Number(process.env.INTERNAL_API_PORT || 4001);

process.env.PORT = String(apiPort);
await import('../server/index.js');

const mime = {
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.webp':'image/webp',
  '.ico':'image/x-icon',
  '.json':'application/json; charset=utf-8',
  '.txt':'text/plain; charset=utf-8',
  '.woff2':'font/woff2'
};

function tryStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://local').pathname); }
  catch { res.writeHead(400).end(); return true; }

  let file = path.resolve(staticRoot, '.' + pathname);
  if (!file.startsWith(staticRoot + path.sep) && file !== staticRoot) {
    res.writeHead(403).end();
    return true;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file) && pathname === '/') file = path.join(staticRoot, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;

  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  if (req.method === 'HEAD') { res.writeHead(200); res.end(); return true; }
  res.writeHead(200);
  fs.createReadStream(file).pipe(res);
  return true;
}

function proxyHttp(req, res) {
  const upstream = http.request({
    host: '127.0.0.1',
    port: apiPort,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${apiPort}` }
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (err) => {
    console.error('[proxy] http error', err.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ error:'UPSTREAM_UNAVAILABLE' }));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (tryStatic(req, res)) return;
  proxyHttp(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(apiPort, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
      else if (value != null) lines.push(`${key}: ${value}`);
    }
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
});

server.listen(publicPort, '0.0.0.0', () => {
  console.log(`Marocto Messenger full-stack: http://0.0.0.0:${publicPort}`);
  console.log(`Internal API: http://127.0.0.1:${apiPort}`);
});
