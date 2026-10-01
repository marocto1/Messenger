import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';

const fail = (message) => Object.assign(new Error(message), { statusCode: 400 });
export function isPublicAddress(address) {
  try {
    let ip = ipaddr.parse(address.replace(/^\[|\]$/g, ''));
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    return ip.range() === 'unicast';
  } catch { return false; }
}

export function validateExternalUrl(raw, { allowLocal = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw fail('Некорректный URL.'); }
  if (raw.length > 1000 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw fail('Нужен HTTP(S) URL без логина и пароля.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!allowLocal && (url.protocol !== 'https:' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (ipaddr.isValid(host) && !isPublicAddress(host))))
    throw fail('Укажи публичный HTTPS адрес. Внутренние адреса запрещены.');
  url.hash = '';
  return url.toString();
}

// Resolve once, reject every private answer, and pin that answer for the socket.
// Node's request does not follow redirects; a redirect cannot escape this check.
export async function postWebhook(raw, payload, { allowLocal = false } = {}) {
  const url = new URL(validateExternalUrl(raw, { allowLocal }));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || (!allowLocal && addresses.some(({ address }) => !isPublicAddress(address))))
    throw fail('Webhook адрес не является публичным.');
  const selected = addresses[0];
  await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST',
      lookup: (_host, options, callback) => options?.all
        ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'MessengerBotWebhook/1.0' },
      signal: AbortSignal.timeout(5000),
    }, (response) => {
      response.destroy();
      response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(new Error(`Webhook HTTP ${response.statusCode}`));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

export function detectSafeMime(buffer, declared = '') {
  const ascii = buffer.subarray(0, 16).toString('latin1');
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(ascii)) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii.startsWith('OggS')) return declared.startsWith('video/') ? 'video/ogg' : 'audio/ogg';
  if (ascii.startsWith('fLaC')) return 'audio/flac';
  if (ascii.startsWith('ID3') || (buffer[0] === 255 && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buffer.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) return declared.startsWith('audio/') ? 'audio/webm' : 'video/webm';
  if (ascii.slice(4, 8) === 'ftyp') return declared.startsWith('audio/') ? 'audio/mp4' : 'video/mp4';
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  // HTML, SVG and arbitrary scripts are never served inline under a claimed MIME.
  return 'application/octet-stream';
}

export const inlineMime = (type) => /^(image\/(png|jpeg|gif|webp)|audio\/(wav|ogg|flac|mpeg|webm|mp4)|video\/(ogg|webm|mp4))$/.test(type);
