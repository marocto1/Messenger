import http from 'node:http';

const PORT = 5050;
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { console.log('[WEBHOOK]', JSON.stringify(JSON.parse(raw), null, 2)); }
    catch { console.log('[WEBHOOK RAW]', raw); }
    res.writeHead(204).end();
    return;
  }

  if (req.method === 'GET' && req.url === '/mini-app') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Messenger Mini App</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1016;color:#f5f7fb;font-family:system-ui,sans-serif}.card{width:min(92%,520px);padding:28px;border:1px solid #ffffff18;border-radius:24px;background:#151a23;box-shadow:0 24px 80px #0008}b{font-size:22px}.tag{display:inline-block;margin-bottom:12px;padding:5px 9px;border-radius:999px;background:#8bd4ed22;color:#b1e5f5;font-size:11px}p{color:#99a2b3;line-height:1.6}button{height:42px;border:0;border-radius:12px;padding:0 16px;background:#8bd4ed;color:white;font-weight:700;cursor:pointer}</style></head>
<body><div class="card"><span class="tag">Marocto Messenger 1.0 Mini App</span><br><b>It works.</b><p>This page is served by the included demo server and rendered inside the messenger's sandboxed Mini App window.</p><button onclick="document.querySelector('p').textContent='Button clicked at '+new Date().toLocaleTimeString()">Test button</button></div></body></html>`);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Messenger Bot demo\n\nWebhook: http://localhost:${PORT}/webhook\nMini App: http://localhost:${PORT}/mini-app\n`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Bot demo server: http://localhost:${PORT}`);
  console.log(`Webhook:         http://localhost:${PORT}/webhook`);
  console.log(`Mini App:        http://localhost:${PORT}/mini-app`);
});
