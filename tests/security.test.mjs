import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, validateExternalUrl, detectSafeMime } from '../server/security.js';
test('SSRF: loopback, private, link-local, mapped IPv6 and URL tricks', () => {
  for (const address of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.169.254','0.0.0.0','::1','fc00::1','fe80::1','::ffff:127.0.0.1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  for (const url of ['http://example.com','https://127.0.0.1','https://2130706433','https://[::ffff:127.0.0.1]','https://localhost.','https://user:secret@example.com','file:///etc/passwd','javascript:alert(1)']) assert.throws(() => validateExternalUrl(url), undefined, url);
  assert.equal(validateExternalUrl('https://example.com/hook'), 'https://example.com/hook');
});
test('MIME: claimed images cannot execute HTML/SVG', () => {
  assert.equal(detectSafeMime(Buffer.from('<svg onload="x()">'), 'image/svg+xml'),'application/octet-stream');
  assert.equal(detectSafeMime(Buffer.from('<html><script>x()</script>'), 'image/png'),'application/octet-stream');
  assert.equal(detectSafeMime(Buffer.from([137,80,78,71,13,10,26,10]),'text/html'),'image/png');
});
