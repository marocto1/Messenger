import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';
import { WebSocketServer, WebSocket } from 'ws';
import { detectSafeMime, inlineMime, validateExternalUrl, postWebhook } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 4000);
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGIN || 'http://localhost:3000,http://tauri.localhost,https://tauri.localhost,tauri://localhost,capacitor://localhost,http://localhost,https://localhost').split(',').map((item) => item.trim()).filter(Boolean));
const DEFAULT_ALLOWED_ORIGIN = [...ALLOWED_ORIGINS][0] || 'http://localhost:3000';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_RESUMABLE_BYTES = 512 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const WEBAUTHN_RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Messenger';
const WEBAUTHN_ORIGINS = (process.env.WEBAUTHN_ORIGINS || 'http://localhost:3000,http://tauri.localhost,https://tauri.localhost').split(',').map((x) => x.trim()).filter(Boolean);
const SFU_URL = process.env.SFU_URL || '';
const TURN_URL = process.env.TURN_URL || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
const TOTP_ISSUER = process.env.TOTP_ISSUER || 'Messenger';
const SECURITY_MASTER_KEY = process.env.SECURITY_MASTER_KEY || 'development-only-change-me-before-production';
if (process.env.NODE_ENV === 'production' && (SECURITY_MASTER_KEY.length < 32 || /development|replace|change.me/i.test(SECURITY_MASTER_KEY))) throw new Error('Set a unique SECURITY_MASTER_KEY of at least 32 characters for production.');
const ALLOW_LOCAL_WEBHOOKS = process.env.NODE_ENV !== 'production' && process.env.ALLOW_LOCAL_WEBHOOKS === 'true';
const rateBuckets = new Map();
const mediaTickets = new Map();
const rateBucketCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (!bucket || now >= bucket.resetAt) rateBuckets.delete(key);
}, 10 * 60_000);
rateBucketCleanupTimer.unref?.();
const dataPath = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const dbPath = path.join(dataPath, 'messenger.db');
const uploadsPath = path.join(dataPath, 'uploads');
const uploadPartsPath = path.join(dataPath, 'upload-parts');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(uploadsPath, { recursive: true });
fs.mkdirSync(uploadPartsPath, { recursive: true });

const lockPath = path.join(dataPath, 'server.lock');
if (fs.existsSync(lockPath)) {
  const pid = Number(fs.readFileSync(lockPath, 'utf8')); let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
  if (alive) throw new Error('Another server is using DATA_DIR. Stop it before starting or restoring.');
  fs.unlinkSync(lockPath);
}
fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
process.on('exit', () => { try { if (fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.unlinkSync(lockPath); } catch {} });

const db = createDatabase(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
initDatabase();

const userSockets = new Map();
const activeCalls = new Map();
const activeVoiceRooms = new Map();
const voiceRoomByUser = new Map();
const twoFactorLoginChallenges = new Map();
const twoFactorSetupChallenges = new Map();
const webauthnChallenges = new Map();
let webauthnModulePromise = null;

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) return json(res, 403, { error: 'ORIGIN_DENIED', message: 'Этот источник не разрешён.' });
  if (req.method === 'OPTIONS') return sendEmpty(res, 204);

  try {
    assertRateLimit(`requests:${clientKey(req)}`, 1200, 60_000);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /health') {
      return json(res, 200, { ok: true, service: 'messenger-server', version: '1.0.0', database: 'ok', realtimeUsers: userSockets.size });
    }

    if (route === 'POST /auth/register') {
      assertRateLimit(`register:${clientKey(req)}`, 8, 60_000);
      const body = await readJson(req);
      const username = normalizeUsername(body.username);
      const displayName = String(body.displayName || '').trim();
      const password = String(body.password || '');

      validateRegistration(username, displayName, password);
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        return json(res, 409, { error: 'USERNAME_TAKEN', message: 'Этот username уже занят.' });
      }

      const userId = crypto.randomUUID();
      const now = new Date().toISOString();
      const passwordHash = await hashPassword(password);
      db.prepare(`
        INSERT INTO users (id, username, display_name, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, username, displayName, passwordHash, now);

      const session = createSession(userId, req);
      ensureSavedConversation(userId);
      return json(res, 201, { token: session.token, user: publicUser(getUserById(userId)) });
    }

    if (route === 'POST /auth/login') {
      assertRateLimit(`login:${clientKey(req)}`, 20, 60_000);
      const body = await readJson(req);
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      if (password.length > 128) throw httpError(400, 'Пароль слишком длинный.');
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

      if (!user || user.is_bot || !(await verifyPassword(password, user.password_hash))) {
        auditLog(user?.id || null, 'auth.login_failed', { username, ip: clientKey(req) });
        return json(res, 401, { error: 'INVALID_CREDENTIALS', message: 'Неверный username или пароль.' });
      }

      if (user.two_factor_enabled) {
        const challengeId = crypto.randomUUID();
        twoFactorLoginChallenges.set(challengeId, { userId: user.id, expiresAt: Date.now() + 5 * 60_000 });
        auditLog(user.id, 'auth.2fa_challenge', { ip: clientKey(req) });
        return json(res, 202, { requiresTwoFactor: true, challengeId });
      }

      const session = createSession(user.id, req);
      ensureSavedConversation(user.id);
      auditLog(user.id, 'auth.login', { sessionId: session.id, ip: clientKey(req) });
      return json(res, 200, { token: session.token, user: publicUser(user) });
    }

    if (route === 'POST /auth/2fa/verify') {
      assertRateLimit(`2fa-login:${clientKey(req)}`, 12, 5 * 60_000);
      const body = await readJson(req);
      const challengeId = String(body.challengeId || '');
      const code = String(body.code || '').replace(/\s+/g, '');
      const pending = twoFactorLoginChallenges.get(challengeId);
      twoFactorLoginChallenges.delete(challengeId);
      if (!pending || pending.expiresAt < Date.now()) return json(res, 401, { error: 'CHALLENGE_EXPIRED', message: 'Код входа устарел. Войди заново.' });
      const user = getUserById(pending.userId);
      if (!user?.two_factor_enabled || !consumeSecondFactor(user, code)) {
        auditLog(pending.userId, 'auth.2fa_failed', { ip: clientKey(req) });
        return json(res, 401, { error: 'INVALID_2FA', message: 'Неверный код двухэтапной проверки.' });
      }
      const session = createSession(user.id, req);
      ensureSavedConversation(user.id);
      auditLog(user.id, 'auth.login_2fa', { sessionId: session.id, ip: clientKey(req) });
      return json(res, 200, { token: session.token, user: publicUser(user) });
    }

    if (route === 'POST /auth/passkeys/options') {
      assertRateLimit(`passkey-options:${clientKey(req)}`, 20, 60_000);
      const body = await readJson(req);
      const username = normalizeUsername(body.username);
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user) return json(res, 404, { error: 'USER_NOT_FOUND', message: 'Пользователь не найден.' });
      const passkeys = db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at').all(user.id);
      if (!passkeys.length) return json(res, 400, { error: 'NO_PASSKEYS', message: 'Для аккаунта ещё не добавлены passkeys.' });
      const wa = await getWebAuthn();
      const options = await wa.generateAuthenticationOptions({
        rpID: WEBAUTHN_RP_ID,
        userVerification: 'required',
        allowCredentials: passkeys.map((key) => ({ id: key.credential_id, transports: parseJson(key.transports_json, []) }))
      });
      const challengeId = crypto.randomUUID();
      webauthnChallenges.set(challengeId, { kind: 'authentication', challenge: options.challenge, userId: user.id, expiresAt: Date.now() + 5 * 60_000 });
      return json(res, 200, { challengeId, options });
    }

    if (route === 'POST /auth/passkeys/verify') {
      assertRateLimit(`passkey-verify:${clientKey(req)}`, 20, 60_000);
      const body = await readJson(req);
      const challengeId = String(body.challengeId || '');
      const pending = webauthnChallenges.get(challengeId);
      webauthnChallenges.delete(challengeId);
      if (!pending || pending.kind !== 'authentication' || pending.expiresAt < Date.now()) throw httpError(401, 'Passkey challenge устарел.');
      const response = body.response;
      const passkey = db.prepare('SELECT * FROM passkeys WHERE credential_id = ? AND user_id = ?').get(String(response?.id || ''), pending.userId);
      if (!passkey) throw httpError(401, 'Passkey не зарегистрирован.');
      const wa = await getWebAuthn();
      const verification = await wa.verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: WEBAUTHN_ORIGINS,
        expectedRPID: WEBAUTHN_RP_ID,
        requireUserVerification: true,
        credential: {
          id: passkey.credential_id,
          publicKey: new Uint8Array(Buffer.from(passkey.public_key_b64, 'base64')),
          counter: Number(passkey.counter || 0),
          transports: parseJson(passkey.transports_json, [])
        }
      }).catch(() => { throw httpError(401, 'Не удалось подтвердить passkey.'); });
      if (!verification.verified) throw httpError(401, 'Не удалось подтвердить passkey.');
      db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, new Date().toISOString(), passkey.id);
      const user = getUserById(pending.userId);
      const session = createSession(user.id, req);
      auditLog(user.id, 'auth.login_passkey', { sessionId: session.id, credentialId: passkey.credential_id });
      return json(res, 200, { token: session.token, user: publicUser(user) });
    }


    if (url.pathname.startsWith('/botapi/')) {
      const botAuth = authenticateBot(req);
      if (!botAuth) return json(res, 401, { error: 'BOT_UNAUTHORIZED', message: 'Неверный bot token.' });

      if (route === 'GET /botapi/getMe') {
        return json(res, 200, { ok: true, bot: publicUser(botAuth.user) });
      }

      if (route === 'POST /botapi/setWebhook') {
        const body = await readJson(req);
        const webhookUrl = body.url ? validateWebhookUrl(String(body.url)) : null;
        db.prepare('UPDATE bots SET webhook_url = ?, updated_at = ? WHERE id = ?')
          .run(webhookUrl, new Date().toISOString(), botAuth.bot.id);
        return json(res, 200, { ok: true, webhookUrl });
      }


      if (route === 'POST /botapi/setMiniApp') {
        const body = await readJson(req);
        const miniAppUrl = body.url ? validateWebhookUrl(String(body.url)) : null;
        db.prepare('UPDATE bots SET mini_app_url = ?, updated_at = ? WHERE id = ?')
          .run(miniAppUrl, new Date().toISOString(), botAuth.bot.id);
        return json(res, 200, { ok: true, miniAppUrl });
      }

      if (route === 'POST /botapi/sendMessage') {
        assertRateLimit(`bot-send:${botAuth.bot.id}`, 90, 60_000);
        const body = await readJson(req);
        const conversationId = String(body.chatId || body.conversationId || '');
        if (!conversationId || !isMember(conversationId, botAuth.user.id)) throw httpError(403, 'Бот не состоит в этом чате.');
        assertCanMessage(conversationId, botAuth.user.id);
        const message = createMessage(conversationId, botAuth.user.id, { body: body.text || body.body || '', replyToId: body.replyToId || null });
        emitMessageSideEffects(message, botAuth.user.id);
        broadcastConversation(conversationId, { type: 'message:new', message });
        return json(res, 201, { ok: true, message });
      }

      return json(res, 404, { error: 'BOT_API_NOT_FOUND' });
    }

    const auth = authenticate(req) || authenticateMediaTicket(req, url);
    if (!auth) return json(res, 401, { error: 'UNAUTHORIZED', message: 'Нужно войти в аккаунт.' });
    assertRateLimit(`account:${auth.user.id}`, 900, 60_000);
    touchSession(auth.sessionId);

    if (route === 'POST /auth/logout') {
      db.prepare('DELETE FROM push_devices WHERE session_id = ?').run(auth.sessionId);
      db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(auth.sessionId, auth.user.id);
      closeSessionSockets(auth.sessionId);
      return sendEmpty(res, 204);
    }

    if (route === 'GET /auth/sessions') {
      const sessions = db.prepare(`
        SELECT id, created_at, expires_at, last_seen_at, user_agent, ip_address
        FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC, created_at DESC
      `).all(auth.user.id).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at || row.created_at,
        userAgent: row.user_agent || 'Unknown device',
        ipAddress: row.ip_address || null,
        current: row.id === auth.sessionId
      }));
      return json(res, 200, { sessions });
    }

    if (route === 'DELETE /auth/sessions/others') {
      const rows = db.prepare('SELECT id FROM sessions WHERE user_id = ? AND id != ?').all(auth.user.id, auth.sessionId);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(auth.user.id, auth.sessionId);
      for (const row of rows) closeSessionSockets(row.id);
      return sendEmpty(res, 204);
    }

    const sessionMatch = url.pathname.match(/^\/auth\/sessions\/([^/]+)$/);
    if (req.method === 'DELETE' && sessionMatch) {
      const sessionId = sessionMatch[1];
      if (sessionId === auth.sessionId) return json(res, 400, { error: 'CURRENT_SESSION', message: 'Текущую сессию завершай через выход из аккаунта.' });
      const result = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(sessionId, auth.user.id);
      if (!result.changes) return json(res, 404, { error: 'SESSION_NOT_FOUND', message: 'Сессия не найдена.' });
      closeSessionSockets(sessionId);
      return sendEmpty(res, 204);
    }

    if (route === 'GET /me') {
      ensureSavedConversation(auth.user.id);
      return json(res, 200, { user: publicUser(getUserById(auth.user.id)) });
    }

    if (route === 'GET /security') {
      const passkeys = db.prepare('SELECT id, name, credential_id, device_type, backed_up, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at DESC').all(auth.user.id)
        .map((row) => ({ id: row.id, name: row.name || 'Passkey', credentialId: row.credential_id, deviceType: row.device_type || 'unknown', backedUp: Boolean(row.backed_up), createdAt: row.created_at, lastUsedAt: row.last_used_at || null }));
      const user = getUserById(auth.user.id);
      return json(res, 200, { twoFactorEnabled: Boolean(user.two_factor_enabled), passkeys });
    }

    if (route === 'POST /security/2fa/setup') {
      if (auth.user.two_factor_enabled) throw httpError(409, '2FA уже включена. Сначала отключи её текущим кодом.');
      assertRateLimit(`2fa-setup:${auth.user.id}`, 10, 60_000);
      const secret = randomBase32(20);
      const setupId = crypto.randomUUID();
      twoFactorSetupChallenges.set(setupId, { userId: auth.user.id, secret, expiresAt: Date.now() + 10 * 60_000 });
      const label = encodeURIComponent(`${TOTP_ISSUER}:${auth.user.username}`);
      const issuer = encodeURIComponent(TOTP_ISSUER);
      const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
      auditLog(auth.user.id, 'security.2fa_setup_started', {});
      return json(res, 200, { setupId, secret, uri });
    }

    if (route === 'POST /security/2fa/confirm') {
      assertRateLimit(`2fa-confirm:${auth.user.id}`, 12, 5 * 60_000);
      if (getUserById(auth.user.id).two_factor_enabled) throw httpError(409, '2FA уже включена.');
      const body = await readJson(req);
      const setupId = String(body.setupId || '');
      const code = String(body.code || '').replace(/\s+/g, '');
      const pending = twoFactorSetupChallenges.get(setupId);
      if (!pending || pending.userId !== auth.user.id || pending.expiresAt < Date.now()) throw httpError(400, 'Настройка 2FA устарела. Начни заново.');
      if (!verifyTotp(pending.secret, code)) throw httpError(400, 'Неверный код из приложения-аутентификатора.');
      twoFactorSetupChallenges.delete(setupId);
      const recoveryCodes = Array.from({ length: 10 }, () => crypto.randomBytes(8).toString('hex'));
      db.prepare('UPDATE users SET two_factor_enabled = 1, totp_secret_enc = ?, recovery_codes_json = ?, last_totp_step = -1 WHERE id = ?').run(encryptSecret(pending.secret), JSON.stringify(recoveryCodes.map(hashToken)), auth.user.id);
      auditLog(auth.user.id, 'security.2fa_enabled', {});
      return json(res, 200, { twoFactorEnabled: true, recoveryCodes });
    }

    if (route === 'POST /security/2fa/disable') {
      assertRateLimit(`2fa-disable:${auth.user.id}`, 12, 5 * 60_000);
      const body = await readJson(req);
      const user = getUserById(auth.user.id);
      const code = String(body.code || '').replace(/\s+/g, '');
      if (!user.two_factor_enabled) return json(res, 200, { twoFactorEnabled: false });
      if (!consumeSecondFactor(user, code)) throw httpError(401, 'Неверный код двухэтапной проверки.');
      db.prepare("UPDATE users SET two_factor_enabled = 0, totp_secret_enc = NULL, recovery_codes_json = '[]', last_totp_step = -1 WHERE id = ?").run(auth.user.id);
      auditLog(auth.user.id, 'security.2fa_disabled', {});
      return json(res, 200, { twoFactorEnabled: false });
    }

    if (route === 'GET /security/passkeys/options') {
      const wa = await getWebAuthn();
      const existing = db.prepare('SELECT credential_id, transports_json FROM passkeys WHERE user_id = ?').all(auth.user.id);
      const options = await wa.generateRegistrationOptions({
        rpName: WEBAUTHN_RP_NAME,
        rpID: WEBAUTHN_RP_ID,
        userName: auth.user.username,
        userDisplayName: auth.user.display_name,
        attestationType: 'none',
        excludeCredentials: existing.map((key) => ({ id: key.credential_id, transports: parseJson(key.transports_json, []) })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        supportedAlgorithmIDs: [-7, -257]
      });
      const challengeId = crypto.randomUUID();
      webauthnChallenges.set(challengeId, { kind: 'registration', challenge: options.challenge, userId: auth.user.id, expiresAt: Date.now() + 5 * 60_000 });
      return json(res, 200, { challengeId, options });
    }

    if (route === 'POST /security/passkeys/verify') {
      const body = await readJson(req);
      const challengeId = String(body.challengeId || '');
      const pending = webauthnChallenges.get(challengeId);
      webauthnChallenges.delete(challengeId);
      if (!pending || pending.kind !== 'registration' || pending.userId !== auth.user.id || pending.expiresAt < Date.now()) throw httpError(400, 'Passkey challenge устарел.');
      const wa = await getWebAuthn();
      const verification = await wa.verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: WEBAUTHN_ORIGINS,
        expectedRPID: WEBAUTHN_RP_ID,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257]
      }).catch(() => { throw httpError(400, 'Некорректный ответ passkey.'); });
      if (!verification.verified || !verification.registrationInfo) throw httpError(400, 'Passkey не подтверждён.');
      const info = verification.registrationInfo;
      const cred = info.credential;
      const name = String(body.name || 'Passkey').trim().slice(0, 60) || 'Passkey';
      db.prepare(`INSERT INTO passkeys (id, user_id, name, credential_id, public_key_b64, counter, transports_json, device_type, backed_up, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), auth.user.id, name, cred.id, Buffer.from(cred.publicKey).toString('base64'), Number(cred.counter || 0), JSON.stringify(cred.transports || body.response?.response?.transports || []), info.credentialDeviceType || 'unknown', info.credentialBackedUp ? 1 : 0, new Date().toISOString());
      auditLog(auth.user.id, 'security.passkey_added', { credentialId: cred.id, deviceType: info.credentialDeviceType });
      return json(res, 201, { verified: true });
    }

    const passkeyDeleteMatch = url.pathname.match(/^\/security\/passkeys\/([^/]+)$/);
    if (req.method === 'DELETE' && passkeyDeleteMatch) {
      const result = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(passkeyDeleteMatch[1], auth.user.id);
      if (!result.changes) throw httpError(404, 'Passkey не найден.');
      auditLog(auth.user.id, 'security.passkey_removed', { id: passkeyDeleteMatch[1] });
      return sendEmpty(res, 204);
    }

    if (route === 'GET /privacy') {
      const row = getUserById(auth.user.id);
      return json(res, 200, { privacy: serializePrivacy(row) });
    }

    if (route === 'PATCH /privacy') {
      const body = await readJson(req);
      const allowed = new Set(['everyone', 'contacts', 'nobody']);
      const lastSeen = allowed.has(body.lastSeen) ? body.lastSeen : getUserById(auth.user.id).privacy_last_seen;
      const calls = allowed.has(body.calls) ? body.calls : getUserById(auth.user.id).privacy_calls;
      const groups = allowed.has(body.groups) ? body.groups : getUserById(auth.user.id).privacy_groups;
      const readReceipts = body.readReceipts === undefined ? getUserById(auth.user.id).read_receipts : (body.readReceipts ? 1 : 0);
      db.prepare('UPDATE users SET privacy_last_seen = ?, privacy_calls = ?, privacy_groups = ?, read_receipts = ? WHERE id = ?').run(lastSeen, calls, groups, readReceipts, auth.user.id);
      broadcastPrivacyChanged(auth.user.id);
      auditLog(auth.user.id, 'privacy.updated', { lastSeen, calls, groups, readReceipts: Boolean(readReceipts) });
      return json(res, 200, { privacy: serializePrivacy(getUserById(auth.user.id)) });
    }

    if (route === 'GET /sync') {
      const after = Math.max(0, Number(url.searchParams.get('after') || 0) || 0);
      const limit = Math.max(10, Math.min(500, Number(url.searchParams.get('limit') || 200) || 200));
      const rows = db.prepare(`SELECT seq, type, conversation_id, payload_json, created_at FROM sync_events WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`).all(auth.user.id, after, limit + 1);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const events = page.map(row => {
        let payload = parseJson(row.payload_json, {});
        if (row.conversation_id && !isMember(row.conversation_id, auth.user.id)) payload = {};
        else if (payload.message?.id || (row.type === 'message:reaction' && payload.messageId)) payload = { ...payload, message: getMessageById(payload.message?.id || payload.messageId, auth.user.id) };
        else if (payload.conversation) payload = { ...payload, conversation: getConversationForUser(row.conversation_id, auth.user.id) };
        return { seq:row.seq, type:row.type, conversationId:row.conversation_id || null, payload, createdAt:row.created_at };
      });
      const oldest = db.prepare('SELECT MIN(seq) AS seq FROM sync_events WHERE user_id = ?').get(auth.user.id).seq;
      return json(res, 200, { cursor: page.length ? page[page.length - 1].seq : after, hasMore, resetNeeded: after > 0 && oldest && after < oldest - 1, events });
    }

    if (route === 'GET /drafts') {
      const rows = db.prepare('SELECT conversation_id, body, reply_to_message_id, updated_at FROM user_drafts WHERE user_id = ? ORDER BY updated_at DESC').all(auth.user.id);
      return json(res, 200, { drafts: rows.map((row) => ({ conversationId: row.conversation_id, body: row.body, replyToId: row.reply_to_message_id || null, updatedAt: row.updated_at })) });
    }

    const draftMatch = url.pathname.match(/^\/drafts\/([^/]+)$/);
    if (draftMatch && req.method === 'PUT') {
      const conversationId = draftMatch[1];
      if (!isMember(conversationId, auth.user.id)) throw httpError(403, 'Нет доступа к чату.');
      const body = await readJson(req);
      const text = String(body.body || '').slice(0, 8000);
      const replyToId = body.replyToId ? String(body.replyToId) : null;
      if (replyToId && !db.prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL').get(replyToId, conversationId)) throw httpError(400, 'Ответ должен относиться к сообщению этого чата.');
      const now = new Date().toISOString();
      if (!text && !replyToId) db.prepare('DELETE FROM user_drafts WHERE user_id = ? AND conversation_id = ?').run(auth.user.id, conversationId);
      else db.prepare(`INSERT INTO user_drafts (user_id, conversation_id, body, reply_to_message_id, updated_at) VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(user_id, conversation_id) DO UPDATE SET body = excluded.body, reply_to_message_id = excluded.reply_to_message_id, updated_at = excluded.updated_at`)
        .run(auth.user.id, conversationId, text, replyToId, now);
      recordSync(auth.user.id, 'draft:updated', conversationId, { body: text, replyToId, updatedAt: now });
      sendToUserExceptSession(auth.user.id, auth.sessionId, { type: 'draft:updated', conversationId, body: text, replyToId, updatedAt: now });
      return json(res, 200, { ok: true, updatedAt: now });
    }

    if (draftMatch && req.method === 'DELETE') {
      if (!isMember(draftMatch[1], auth.user.id)) throw httpError(403, 'Нет доступа к чату.');
      db.prepare('DELETE FROM user_drafts WHERE user_id = ? AND conversation_id = ?').run(auth.user.id, draftMatch[1]);
      recordSync(auth.user.id, 'draft:updated', draftMatch[1], { body: '', replyToId: null, updatedAt: new Date().toISOString() });
      return sendEmpty(res, 204);
    }

    if (route === 'GET /folders') {
      return json(res, 200, { folders: getChatFolders(auth.user.id) });
    }

    if (route === 'POST /folders') {
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 32);
      if (!name) throw httpError(400, 'Название папки пустое.');
      const count = db.prepare('SELECT COUNT(*) AS n FROM chat_folders WHERE user_id = ?').get(auth.user.id).n;
      if (count >= 12) throw httpError(400, 'Максимум 12 папок.');
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO chat_folders (id, user_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)').run(id, auth.user.id, name, Number(count), new Date().toISOString());
      return json(res, 201, { folder: getChatFolders(auth.user.id).find((item) => item.id === id) });
    }

    const folderMatch = url.pathname.match(/^\/folders\/([^/]+)$/);
    if (folderMatch && req.method === 'PATCH') {
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 32);
      if (!name) throw httpError(400, 'Название папки пустое.');
      const result = db.prepare('UPDATE chat_folders SET name = ? WHERE id = ? AND user_id = ?').run(name, folderMatch[1], auth.user.id);
      if (!result.changes) throw httpError(404, 'Папка не найдена.');
      return json(res, 200, { folders: getChatFolders(auth.user.id) });
    }
    if (folderMatch && req.method === 'DELETE') {
      db.prepare('DELETE FROM chat_folders WHERE id = ? AND user_id = ?').run(folderMatch[1], auth.user.id);
      return sendEmpty(res, 204);
    }

    const folderChatsMatch = url.pathname.match(/^\/folders\/([^/]+)\/chats\/([^/]+)$/);
    if (folderChatsMatch && req.method === 'PUT') {
      const [_, folderId, conversationId] = folderChatsMatch;
      if (!db.prepare('SELECT 1 FROM chat_folders WHERE id = ? AND user_id = ?').get(folderId, auth.user.id)) throw httpError(404, 'Папка не найдена.');
      if (!isMember(conversationId, auth.user.id)) throw httpError(403, 'Нет доступа к чату.');
      db.prepare('INSERT OR IGNORE INTO chat_folder_items (folder_id, conversation_id) VALUES (?, ?)').run(folderId, conversationId);
      return sendEmpty(res, 204);
    }
    if (folderChatsMatch && req.method === 'DELETE') {
      db.prepare(`DELETE FROM chat_folder_items WHERE folder_id = ? AND conversation_id = ? AND folder_id IN (SELECT id FROM chat_folders WHERE user_id = ?)`)
        .run(folderChatsMatch[1], folderChatsMatch[2], auth.user.id);
      return sendEmpty(res, 204);
    }

    const conversationStateMatch = url.pathname.match(/^\/conversations\/([^/]+)\/state$/);
    if (conversationStateMatch && req.method === 'PATCH') {
      const conversationId = conversationStateMatch[1];
      if (!isMember(conversationId, auth.user.id)) throw httpError(403, 'Нет доступа к чату.');
      const body = await readJson(req);
      const current = db.prepare('SELECT archived, pinned_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conversationId, auth.user.id);
      const archived = body.archived === undefined ? Number(current.archived || 0) : (body.archived ? 1 : 0);
      const pinnedAt = body.pinned === undefined ? current.pinned_at : (body.pinned ? new Date().toISOString() : null);
      db.prepare('UPDATE conversation_members SET archived = ?, pinned_at = ? WHERE conversation_id = ? AND user_id = ?').run(archived, pinnedAt, conversationId, auth.user.id);
      recordSync(auth.user.id, 'conversation:state', conversationId, { archived: Boolean(archived), pinned: Boolean(pinnedAt) });
      return json(res, 200, { conversation: getConversationForUser(conversationId, auth.user.id) });
    }

    if (route === 'GET /search') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 200, { conversations: [], messages: [], users: [] });
      const like = `%${q.toLowerCase()}%`;
      const conversations = getConversations(auth.user.id).filter((c) => `${c.title} ${c.username || ''} ${c.publicUsername || ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
      const rows = db.prepare(`${messageSelectSql()} JOIN conversation_members sm ON sm.conversation_id = m.conversation_id AND sm.user_id = ? WHERE m.deleted_at IS NULL AND (LOWER(m.body) LIKE ? OR LOWER(md.file_name) LIKE ?) ORDER BY m.created_at DESC, m.id DESC LIMIT 80`).all(auth.user.id, like, like);
      const messages = rows.map((row) => serializeMessage(row, auth.user.id));
      const users = db.prepare('SELECT * FROM users WHERE id != ? AND (LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?) ORDER BY username LIMIT 30').all(auth.user.id, like, like).map(publicUser);
      return json(res, 200, { conversations, messages, users });
    }

    const linksMatch = url.pathname.match(/^\/conversations\/([^/]+)\/links$/);
    if (linksMatch && req.method === 'GET') {
      const conversationId = linksMatch[1];
      if (!isMember(conversationId, auth.user.id)) throw httpError(403, 'Нет доступа к чату.');
      const rows = db.prepare('SELECT id, body, created_at FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND (body LIKE ? OR body LIKE ?) ORDER BY created_at DESC LIMIT 500').all(conversationId, '%http://%', '%https://%');
      const links = [];
      const re = /https?:\/\/[^\s<>()]+/g;
      for (const row of rows) for (const href of String(row.body || '').match(re) || []) links.push({ messageId: row.id, href: href.slice(0, 2000), createdAt: row.created_at });
      return json(res, 200, { links: links.slice(0, 200) });
    }

    if (route === 'GET /rtc/config') {
      const iceServers = [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        ...(TURN_URL ? [{ urls: TURN_URL.split(',').map((x) => x.trim()).filter(Boolean), username: TURN_USERNAME || undefined, credential: TURN_CREDENTIAL || undefined }] : [])
      ];
      return json(res, 200, { iceServers, sfu: { enabled: false, configured: Boolean(SFU_URL), url: SFU_URL || null, reason: 'SFU transport is not implemented; calls use WebRTC mesh.' }, meshGroupVideoLimit: 6, meshVoiceLimit: 8 });
    }

    if (route === 'GET /me/export') {
      assertRateLimit(`export:${auth.user.id}`, 3, 60 * 60_000);
      const data = exportUserData(auth.user.id);
      res.setHeader('Content-Disposition', `attachment; filename=messenger-export-${auth.user.username}.json`);
      return json(res, 200, data);
    }

    if (route === 'GET /audit') {
      const rows = db.prepare('SELECT id, action, metadata_json, created_at FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(auth.user.id);
      return json(res, 200, { entries: rows.map((row) => ({ id: row.id, action: row.action, metadata: parseJson(row.metadata_json, {}), createdAt: row.created_at })) });
    }

    if (route === 'GET /push/devices') {
      const devices = db.prepare(`SELECT id, platform, device_name, created_at, updated_at FROM push_devices WHERE user_id = ? ORDER BY updated_at DESC`).all(auth.user.id)
        .map((row) => ({ id: row.id, platform: row.platform, deviceName: row.device_name || '', createdAt: row.created_at, updatedAt: row.updated_at }));
      return json(res, 200, { devices, configured: Boolean(loadFcmServiceAccount()) });
    }

    if (route === 'POST /push/devices') {
      assertRateLimit(`push-register:${auth.user.id}`, 30, 60_000);
      const body = await readJson(req);
      const tokenValue = String(body.token || '').trim();
      const platform = String(body.platform || 'android').trim().toLowerCase();
      const deviceName = String(body.deviceName || '').trim().slice(0, 120);
      if (!tokenValue || tokenValue.length > 4096) throw httpError(400, 'Некорректный push token.');
      if (!['android', 'ios', 'web'].includes(platform)) throw httpError(400, 'Неизвестная push-платформа.');
      const now = new Date().toISOString();
      const existing = db.prepare('SELECT id FROM push_devices WHERE token = ?').get(tokenValue);
      const id = existing?.id || crypto.randomUUID();
      db.prepare(`INSERT INTO push_devices (id, user_id, token, platform, device_name, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, device_name = excluded.device_name, updated_at = excluded.updated_at`)
        .run(id, auth.user.id, tokenValue, platform, deviceName, now, now);
      db.prepare('UPDATE push_devices SET session_id = ? WHERE token = ?').run(auth.sessionId, token);
      return json(res, 200, { ok: true, id });
    }

    const pushDeviceMatch = url.pathname.match(/^\/push\/devices\/([^/]+)$/);
    if (req.method === 'DELETE' && pushDeviceMatch) {
      db.prepare('DELETE FROM push_devices WHERE id = ? AND user_id = ?').run(pushDeviceMatch[1], auth.user.id);
      return sendEmpty(res, 204);
    }

    if (route === 'GET /scheduled') {
      const conversationId = url.searchParams.get('conversationId');
      const rows = conversationId
        ? db.prepare(`SELECT * FROM scheduled_messages WHERE user_id = ? AND conversation_id = ? AND status = 'pending' ORDER BY send_at ASC`).all(auth.user.id, conversationId)
        : db.prepare(`SELECT * FROM scheduled_messages WHERE user_id = ? AND status = 'pending' ORDER BY send_at ASC LIMIT 200`).all(auth.user.id);
      return json(res, 200, { scheduled: rows.map(serializeScheduledMessage) });
    }

    if (route === 'POST /scheduled') {
      assertRateLimit(`schedule:${auth.user.id}`, 60, 60_000);
      const body = await readJson(req);
      const conversationId = String(body.conversationId || '');
      if (!isMember(conversationId, auth.user.id)) throw httpError(403, 'Нет доступа к чату.');
      assertCanMessage(conversationId, auth.user.id);
      const text = String(body.body || '').trim();
      const replyToId = body.replyToId ? String(body.replyToId) : null;
      const attachmentId = body.attachmentId ? String(body.attachmentId) : null;
      if (!text && !attachmentId) throw httpError(400, 'Сообщение пустое.');
      if (text.length > 8000) throw httpError(400, 'Сообщение слишком длинное.');
      const sendAtDate = new Date(String(body.sendAt || ''));
      if (!Number.isFinite(sendAtDate.getTime())) throw httpError(400, 'Некорректная дата отправки.');
      const min = Date.now() + 30_000;
      const max = Date.now() + 366 * 24 * 60 * 60 * 1000;
      if (sendAtDate.getTime() < min) throw httpError(400, 'Запланируй сообщение минимум на 30 секунд вперёд.');
      if (sendAtDate.getTime() > max) throw httpError(400, 'Нельзя планировать дальше чем на год.');
      if (replyToId) {
        const reply = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(replyToId);
        if (!reply || reply.conversation_id !== conversationId) throw httpError(400, 'Сообщение для ответа не найдено в этом чате.');
      }
      if (attachmentId) {
        const media = db.prepare('SELECT 1 FROM media WHERE id = ? AND owner_id = ?').get(attachmentId, auth.user.id);
        if (!media) throw httpError(400, 'Вложение не найдено.');
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO scheduled_messages (id, user_id, conversation_id, body, reply_to_message_id, attachment_id, send_at, created_at, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(id, auth.user.id, conversationId, text, replyToId, attachmentId, sendAtDate.toISOString(), now);
      return json(res, 201, { scheduled: serializeScheduledMessage(db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id)) });
    }

    const scheduledMatch = url.pathname.match(/^\/scheduled\/([^/]+)$/);
    if (req.method === 'PATCH' && scheduledMatch) {
      const current = db.prepare(`SELECT * FROM scheduled_messages WHERE id = ? AND user_id = ? AND status = 'pending'`).get(scheduledMatch[1], auth.user.id);
      if (!current) throw httpError(404, 'Запланированное сообщение не найдено.');
      const body = await readJson(req);
      const text = body.body === undefined ? current.body : String(body.body || '').trim();
      const sendAt = body.sendAt === undefined ? current.send_at : String(body.sendAt || '');
      if (!text && !current.attachment_id) throw httpError(400, 'Сообщение пустое.');
      if (text.length > 8000) throw httpError(400, 'Сообщение слишком длинное.');
      const when = new Date(sendAt).getTime();
      if (!Number.isFinite(when) || when < Date.now() + 30_000 || when > Date.now() + 366 * 24 * 60 * 60 * 1000) throw httpError(400, 'Некорректное время отправки.');
      db.prepare(`UPDATE scheduled_messages SET body = ?, send_at = ?, error = NULL WHERE id = ?`).run(text, new Date(when).toISOString(), current.id);
      return json(res, 200, { scheduled: serializeScheduledMessage(db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(current.id)) });
    }
    if (req.method === 'DELETE' && scheduledMatch) {
      const result = db.prepare(`UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'`).run(scheduledMatch[1], auth.user.id);
      if (!result.changes) throw httpError(404, 'Запланированное сообщение не найдено.');
      return sendEmpty(res, 204);
    }


    if (route === 'GET /activity') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 60)));
      const before = url.searchParams.get('before');
      const rows = before
        ? db.prepare(`${activitySelectSql()} WHERE a.user_id = ? AND a.created_at < ? ORDER BY a.created_at DESC LIMIT ?`).all(auth.user.id, before, limit)
        : db.prepare(`${activitySelectSql()} WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT ?`).all(auth.user.id, limit);
      const unread = Number(db.prepare('SELECT COUNT(*) AS count FROM activity_events WHERE user_id = ? AND read_at IS NULL').get(auth.user.id)?.count || 0);
      return json(res, 200, { activities: rows.map(serializeActivity), unread });
    }

    if (route === 'POST /activity/read') {
      db.prepare('UPDATE activity_events SET read_at = COALESCE(read_at, ?) WHERE user_id = ?').run(new Date().toISOString(), auth.user.id);
      sendToUser(auth.user.id, { type: 'activity:read' });
      return sendEmpty(res, 204);
    }

    if (route === 'GET /calls/history') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50)));
      const rows = db.prepare(`
        SELECT * FROM calls
        WHERE caller_id = ? OR callee_id = ?
        ORDER BY started_at DESC LIMIT ?
      `).all(auth.user.id, auth.user.id, limit);
      return json(res, 200, { calls: rows.map((row) => serializeCall(row, auth.user.id)) });
    }


    if (route === 'GET /voice-rooms/history') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 40)));
      const rows = db.prepare(`
        SELECT vr.*, c.title,
          (SELECT COUNT(*) FROM voice_room_participants p WHERE p.room_id = vr.id) AS participant_count
        FROM voice_rooms vr
        JOIN conversations c ON c.id = vr.conversation_id
        WHERE EXISTS (
          SELECT 1 FROM voice_room_participants mine WHERE mine.room_id = vr.id AND mine.user_id = ?
        )
        ORDER BY vr.started_at DESC LIMIT ?
      `).all(auth.user.id, limit);
      return json(res, 200, { rooms: rows.map(serializeVoiceRoomHistory) });
    }

    const voiceRoomStatusMatch = url.pathname.match(/^\/voice-rooms\/([^/]+)$/);
    if (req.method === 'GET' && voiceRoomStatusMatch) {
      const conversationId = voiceRoomStatusMatch[1];
      if (!isMember(conversationId, auth.user.id)) throw httpError(403, 'Нет доступа к группе.');
      const room = voiceRoomForConversation(conversationId);
      return json(res, 200, { room: room ? serializeLiveVoiceRoom(room) : null });
    }

    if (route === 'GET /bots') {
      const rows = db.prepare(`
        SELECT b.*, u.username, u.display_name, u.avatar_media_id
        FROM bots b JOIN users u ON u.id = b.user_id
        WHERE b.owner_id = ? ORDER BY b.created_at DESC
      `).all(auth.user.id);
      return json(res, 200, { bots: rows.map(serializeBot) });
    }

    if (route === 'POST /bots') {
      assertRateLimit(`bot-create:${auth.user.id}`, 8, 60 * 60_000);
      const body = await readJson(req);
      const username = normalizeUsername(body.username);
      const displayName = String(body.displayName || '').trim();
      if (!/^[a-z0-9_]{5,24}$/.test(username)) throw httpError(400, 'Username бота: 5–24 символа, a-z, 0-9 и _.');
      if (displayName.length < 1 || displayName.length > 48) throw httpError(400, 'Имя бота — от 1 до 48 символов.');
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw httpError(409, 'Этот username уже занят.');
      const userId = crypto.randomUUID();
      const botId = crypto.randomUUID();
      const token = createBotToken(botId);
      const now = new Date().toISOString();
      const disabledPassword = await hashPassword(crypto.randomBytes(48).toString('base64url'));
      db.transaction(() => {
        db.prepare(`INSERT INTO users (id, username, display_name, password_hash, created_at, is_bot) VALUES (?, ?, ?, ?, ?, 1)`)
          .run(userId, username, displayName, disabledPassword, now);
        db.prepare(`INSERT INTO bots (id, user_id, owner_id, token_hash, token_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(botId, userId, auth.user.id, hashToken(token), token.slice(0, 18), now, now);
      })();
      return json(res, 201, { bot: serializeBot(db.prepare(`SELECT b.*, u.username, u.display_name, u.avatar_media_id FROM bots b JOIN users u ON u.id = b.user_id WHERE b.id = ?`).get(botId)), token });
    }

    if (route === 'GET /bots/search') {
      const q = normalizeUsername(url.searchParams.get('q') || '');
      if (!q) return json(res, 200, { bots: [] });
      const rows = db.prepare(`SELECT u.id, u.username, u.display_name, u.bio, u.avatar_media_id, u.created_at, u.is_bot FROM users u WHERE u.is_bot = 1 AND u.username LIKE ? ORDER BY CASE WHEN u.username = ? THEN 0 ELSE 1 END, u.username LIMIT 30`).all(`${q}%`, q);
      return json(res, 200, { bots: rows.map(publicUser) });
    }

    const botStartMatch = url.pathname.match(/^\/bots\/([^/]+)\/start$/);
    if (req.method === 'POST' && botStartMatch) {
      const username = normalizeUsername(decodeURIComponent(botStartMatch[1]));
      const botUser = db.prepare('SELECT * FROM users WHERE username = ? AND is_bot = 1').get(username);
      if (!botUser) throw httpError(404, 'Бот не найден.');
      const conversation = createOrGetDirectConversation(auth.user.id, botUser.id);
      return json(res, 200, { conversation: getConversationForUser(conversation.id, auth.user.id) });
    }

    const botAppMatch = url.pathname.match(/^\/bots\/([^/]+)\/app$/);
    if (req.method === 'GET' && botAppMatch) {
      const username = normalizeUsername(decodeURIComponent(botAppMatch[1]));
      const row = db.prepare(`SELECT b.mini_app_url FROM bots b JOIN users u ON u.id = b.user_id WHERE u.username = ?`).get(username);
      if (!row) throw httpError(404, 'Бот не найден.');
      return json(res, 200, { miniAppUrl: row.mini_app_url || null });
    }

    const botRotateMatch = url.pathname.match(/^\/bots\/([^/]+)\/rotate-token$/);
    if (req.method === 'POST' && botRotateMatch) {
      const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(botRotateMatch[1], auth.user.id);
      if (!bot) throw httpError(404, 'Бот не найден.');
      const token = createBotToken(bot.id);
      db.prepare('UPDATE bots SET token_hash = ?, token_prefix = ?, updated_at = ? WHERE id = ?').run(hashToken(token), token.slice(0, 18), new Date().toISOString(), bot.id);
      return json(res, 200, { token });
    }

    if (route === 'PATCH /me') {
      const body = await readJson(req);
      const displayName = String(body.displayName ?? auth.user.display_name).trim();
      const bio = String(body.bio ?? auth.user.bio ?? '').trim();
      const avatarMediaId = body.avatarMediaId === null ? null : (body.avatarMediaId ? String(body.avatarMediaId) : auth.user.avatar_media_id || null);
      if (displayName.length < 2 || displayName.length > 48) throw httpError(400, 'Имя должно содержать от 2 до 48 символов.');
      if (bio.length > 160) throw httpError(400, 'Описание профиля — максимум 160 символов.');
      if (avatarMediaId) {
        const media = db.prepare("SELECT 1 FROM media WHERE id = ? AND owner_id = ? AND mime_type IN ('image/png','image/jpeg','image/gif','image/webp')").get(avatarMediaId, auth.user.id);
        if (!media) throw httpError(400, 'Аватар не найден или не принадлежит тебе.');
      }
      db.prepare('UPDATE users SET display_name = ?, bio = ?, avatar_media_id = ? WHERE id = ?')
        .run(displayName, bio, avatarMediaId, auth.user.id);
      return json(res, 200, { user: publicUser(getUserById(auth.user.id)) });
    }

    const publicProfileMatch = url.pathname.match(/^\/users\/([^/]+)\/profile$/);
    if (req.method === 'GET' && publicProfileMatch) {
      const username = normalizeUsername(decodeURIComponent(publicProfileMatch[1]));
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user) return json(res, 404, { error: 'USER_NOT_FOUND', message: 'Пользователь не найден.' });
      return json(res, 200, { user: publicUser(user) });
    }

    if (route === 'GET /users/search') {
      const q = normalizeUsername(url.searchParams.get('q') || '');
      if (!q) return json(res, 200, { users: [] });
      const users = db.prepare(`
        SELECT id, username, display_name, created_at
        FROM users
        WHERE username LIKE ? AND id != ?
        ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END, username ASC
        LIMIT 20
      `).all(`${q}%`, auth.user.id, q).map(publicUser);
      return json(res, 200, { users });
    }

    if (route === 'GET /conversations') {
      ensureSavedConversation(auth.user.id);
      return json(res, 200, { conversations: getConversations(auth.user.id) });
    }

    if (route === 'POST /conversations/direct') {
      const body = await readJson(req);
      const username = normalizeUsername(body.username);
      const other = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!other) return json(res, 404, { error: 'USER_NOT_FOUND', message: 'Пользователь не найден.' });
      if (other.id === auth.user.id) {
        const saved = ensureSavedConversation(auth.user.id);
        return json(res, 200, { conversation: getConversationForUser(saved.id, auth.user.id) });
      }
      if (isBlockedEitherWay(auth.user.id, other.id)) throw httpError(403, 'Личный чат недоступен из-за блокировки.');

      const conversation = createOrGetDirectConversation(auth.user.id, other.id);
      return json(res, 200, { conversation: getConversationForUser(conversation.id, auth.user.id) });
    }


    if (route === 'POST /conversations/group') {
      const body = await readJson(req);
      const title = String(body.title || '').trim();
      const usernames = Array.isArray(body.usernames) ? body.usernames.map(normalizeUsername).filter(Boolean) : [];
      if (title.length < 2 || title.length > 64) throw httpError(400, 'Название группы — от 2 до 64 символов.');
      const unique = [...new Set(usernames)].filter((username) => username !== auth.user.username);
      if (unique.length > 99) throw httpError(400, 'В группе максимум 100 участников вместе с владельцем.');
      const users = unique.length ? db.prepare(`SELECT * FROM users WHERE username IN (${unique.map(() => '?').join(',')})`).all(...unique) : [];
      if (users.length !== unique.length) {
        const found = new Set(users.map((u) => u.username));
        const missing = unique.filter((u) => !found.has(u));
        throw httpError(404, `Не найдены: ${missing.map((u) => '@' + u).join(', ')}`);
      }
      const denied = users.filter((u) => !canAddUserToGroup(auth.user.id, u.id));
      if (denied.length) throw httpError(403, `Настройки приватности запрещают добавление: ${denied.map((u) => '@' + u.username).join(', ')}`);
      const conversation = createGroupConversation(auth.user.id, title, users.map((u) => u.id));
      broadcastConversation(conversation.id, { type: 'conversation:updated', conversation: getConversationForUser(conversation.id, auth.user.id) });
      return json(res, 201, { conversation: getConversationForUser(conversation.id, auth.user.id) });
    }

    if (route === 'POST /channels') {
      assertRateLimit(`channel-create:${auth.user.id}`, 6, 60 * 60_000);
      const body = await readJson(req);
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const publicUsername = normalizeChannelUsername(body.username || '');
      if (title.length < 2 || title.length > 64) throw httpError(400, 'Название канала — от 2 до 64 символов.');
      if (description.length > 500) throw httpError(400, 'Описание канала — максимум 500 символов.');
      if (body.username && !publicUsername) throw httpError(400, 'Username канала: 3–24 символа, латиница, цифры и _.');
      if (publicUsername && db.prepare('SELECT 1 FROM conversations WHERE public_username = ?').get(publicUsername)) throw httpError(409, 'Этот username канала уже занят.');
      const channel = createChannelConversation(auth.user.id, title, description, publicUsername);
      return json(res, 201, { conversation: getConversationForUser(channel.id, auth.user.id) });
    }

    if (route === 'GET /channels/search') {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '');
      if (!q) return json(res, 200, { channels: [] });
      const rows = db.prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) AS subscriber_count,
          EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = ?) AS subscribed
        FROM conversations c
        WHERE c.is_channel = 1 AND c.public_username IS NOT NULL
          AND (LOWER(c.public_username) LIKE ? OR LOWER(c.title) LIKE ?)
        ORDER BY CASE WHEN LOWER(c.public_username) = ? THEN 0 ELSE 1 END, subscriber_count DESC, c.updated_at DESC
        LIMIT 30
      `).all(auth.user.id, `${q}%`, `%${q}%`, q);
      return json(res, 200, { channels: rows.map(serializeChannelPreview) });
    }

    const channelJoinMatch = url.pathname.match(/^\/channels\/([^/]+)\/join$/);
    if (req.method === 'POST' && channelJoinMatch) {
      assertRateLimit(`channel-join:${auth.user.id}`, 20, 60_000);
      const key = decodeURIComponent(channelJoinMatch[1]);
      const channel = db.prepare('SELECT * FROM conversations WHERE is_channel = 1 AND (id = ? OR public_username = ?)').get(key, normalizeChannelUsername(key));
      if (!channel) throw httpError(404, 'Публичный канал не найден.');
      if (!channel.public_username && !isMember(channel.id, auth.user.id)) throw httpError(403, 'Это приватный канал — нужна invite-ссылка.');
      subscribeToChannel(channel, auth.user.id);
      broadcastConversation(channel.id, { type: 'conversation:updated', conversationId: channel.id });
      return json(res, 200, { conversation: getConversationForUser(channel.id, auth.user.id) });
    }

    const channelLeaveMatch = url.pathname.match(/^\/channels\/([^/]+)\/leave$/);
    if (req.method === 'DELETE' && channelLeaveMatch) {
      const channel = db.prepare('SELECT * FROM conversations WHERE id = ? AND is_channel = 1').get(channelLeaveMatch[1]);
      if (!channel) throw httpError(404, 'Канал не найден.');
      const membership = getMembership(channel.id, auth.user.id);
      if (!membership) return sendEmpty(res, 204);
      if (membership.role === 'owner') throw httpError(400, 'Владелец не может покинуть канал.');
      unsubscribeFromChannel(channel, auth.user.id);
      sendToUser(auth.user.id, { type: 'conversation:removed', conversationId: channel.id });
      broadcastConversation(channel.id, { type: 'conversation:updated', conversationId: channel.id });
      return sendEmpty(res, 204);
    }

    const channelSettingsMatch = url.pathname.match(/^\/channels\/([^/]+)$/);
    if (req.method === 'PATCH' && channelSettingsMatch) {
      const channelId = channelSettingsMatch[1];
      requireChannelRole(channelId, auth.user.id, ['owner', 'admin']);
      const channel = db.prepare('SELECT * FROM conversations WHERE id = ? AND is_channel = 1').get(channelId);
      const body = await readJson(req);
      const title = body.title !== undefined ? String(body.title).trim() : channel.title;
      const description = body.description !== undefined ? String(body.description).trim() : (channel.description || '');
      const username = body.username === null || body.username === '' ? null : (body.username !== undefined ? normalizeChannelUsername(body.username) : channel.public_username);
      if (title.length < 2 || title.length > 64) throw httpError(400, 'Название канала — от 2 до 64 символов.');
      if (description.length > 500) throw httpError(400, 'Описание канала — максимум 500 символов.');
      if (body.username !== undefined && body.username !== null && body.username !== '' && !username) throw httpError(400, 'Некорректный username канала.');
      if (username) {
        const occupied = db.prepare('SELECT id FROM conversations WHERE public_username = ? AND id != ?').get(username, channelId);
        if (occupied) throw httpError(409, 'Этот username канала уже занят.');
      }
      db.prepare('UPDATE conversations SET title = ?, description = ?, public_username = ?, updated_at = ? WHERE id = ?')
        .run(title, description, username, new Date().toISOString(), channelId);
      broadcastConversation(channelId, { type: 'conversation:updated', conversationId: channelId });
      return json(res, 200, { conversation: getConversationForUser(channelId, auth.user.id) });
    }

    const channelCommentsMatch = url.pathname.match(/^\/channels\/([^/]+)\/posts\/([^/]+)\/comments$/);
    if (channelCommentsMatch && req.method === 'GET') {
      const [_, channelId, postId] = channelCommentsMatch;
      const channel = requireChannelMember(channelId, auth.user.id);
      const post = db.prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL').get(postId, channelId);
      if (!post) throw httpError(404, 'Пост не найден.');
      const rows = db.prepare(`${messageSelectSql()} WHERE m.conversation_id = ? AND m.channel_post_id = ? ORDER BY m.created_at ASC LIMIT 300`)
        .all(channel.discussion_conversation_id, postId);
      return json(res, 200, { comments: rows.map((row) => serializeMessage(row, auth.user.id)) });
    }
    if (channelCommentsMatch && req.method === 'POST') {
      assertRateLimit(`channel-comments:${auth.user.id}`, 40, 60_000);
      const [_, channelId, postId] = channelCommentsMatch;
      const channel = requireChannelMember(channelId, auth.user.id);
      const post = db.prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL').get(postId, channelId);
      if (!post) throw httpError(404, 'Пост не найден.');
      if (!channel.discussion_conversation_id) throw httpError(409, 'Комментарии для канала не настроены.');
      subscribeToDiscussion(channel, auth.user.id);
      const body = await readJson(req);
      const comment = createMessage(channel.discussion_conversation_id, auth.user.id, { ...body, channelPostId: postId });
      emitMessageSideEffects(comment, auth.user.id);
      const postOwner = db.prepare('SELECT sender_id FROM messages WHERE id = ?').get(postId);
      if (postOwner?.sender_id && postOwner.sender_id !== auth.user.id) createActivity(postOwner.sender_id, 'channel_comment', auth.user.id, channel.id, postId, { commentId: comment.id });
      broadcastConversation(channel.discussion_conversation_id, { type: 'message:new', message: comment });
      broadcastConversation(channel.id, { type: 'channel:comments', conversationId: channel.id, postId });
      return json(res, 201, { comment });
    }

    const conversationInfoMatch = url.pathname.match(/^\/conversations\/([^/]+)$/);
    if (req.method === 'PATCH' && conversationInfoMatch) {
      const conversationId = conversationInfoMatch[1];
      const membership = getMembership(conversationId, auth.user.id);
      if (!membership) return json(res, 403, { error: 'FORBIDDEN' });
      const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
      if (!conversation || conversation.kind !== 'group' || conversation.is_channel) throw httpError(400, 'Настройки доступны только для групп.');
      if (!['owner', 'admin'].includes(membership.role)) throw httpError(403, 'Нужны права администратора.');
      const body = await readJson(req);
      const title = body.title !== undefined ? String(body.title).trim() : conversation.title;
      const avatarMediaId = body.avatarMediaId === null ? null : (body.avatarMediaId ? String(body.avatarMediaId) : conversation.avatar_media_id || null);
      if (!title || title.length > 64) throw httpError(400, 'Название группы — от 2 до 64 символов.');
      if (avatarMediaId) {
        const media = db.prepare("SELECT 1 FROM media WHERE id = ? AND owner_id = ? AND mime_type IN ('image/png','image/jpeg','image/gif','image/webp')").get(avatarMediaId, auth.user.id);
        if (!media) throw httpError(400, 'Аватар группы не найден.');
      }
      const now = new Date().toISOString();
      db.prepare('UPDATE conversations SET title = ?, avatar_media_id = ?, updated_at = ? WHERE id = ?')
        .run(title, avatarMediaId, now, conversationId);
      broadcastConversation(conversationId, { type: 'conversation:updated', conversationId });
      return json(res, 200, { conversation: getConversationForUser(conversationId, auth.user.id) });
    }

    const groupMembersMatch = url.pathname.match(/^\/conversations\/([^/]+)\/members$/);
    if (req.method === 'POST' && groupMembersMatch) {
      const conversationId = groupMembersMatch[1];
      requireGroupRole(conversationId, auth.user.id, ['owner', 'admin']);
      const body = await readJson(req);
      const username = normalizeUsername(body.username);
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user) throw httpError(404, 'Пользователь не найден.');
      if (!isMember(conversationId,user.id) && db.prepare('SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id = ?').get(conversationId).count >= 100) throw httpError(400,'В группе максимум 100 участников.');
      if (!canAddUserToGroup(auth.user.id, user.id)) throw httpError(403, 'Пользователь запретил добавление в группы настройками приватности.');
      const now = new Date().toISOString();
      db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, 'member', ?, ?)`)
        .run(conversationId, user.id, now, now);
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
      broadcastConversation(conversationId, { type: 'conversation:updated', conversationId });
      sendToUser(user.id, { type: 'conversation:added', conversation: getConversationForUser(conversationId, user.id) });
      return json(res, 200, { conversation: getConversationForUser(conversationId, auth.user.id) });
    }

    const memberRoleMatch = url.pathname.match(/^\/conversations\/([^/]+)\/members\/([^/]+)$/);
    if (req.method === 'PATCH' && memberRoleMatch) {
      const conversationId = memberRoleMatch[1];
      const targetUserId = memberRoleMatch[2];
      requireGroupOrChannelRole(conversationId, auth.user.id, ['owner']);
      const body = await readJson(req);
      const role = String(body.role || 'member');
      if (!['admin', 'member'].includes(role)) throw httpError(400, 'Допустимые роли: admin или member.');
      const target = getMembership(conversationId, targetUserId);
      if (!target) throw httpError(404, 'Участник не найден.');
      if (target.role === 'owner') throw httpError(400, 'Нельзя изменить роль владельца.');
      db.prepare('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?').run(role, conversationId, targetUserId);
      broadcastConversation(conversationId, { type: 'conversation:updated', conversationId });
      return json(res, 200, { conversation: getConversationForUser(conversationId, auth.user.id) });
    }

    if (req.method === 'DELETE' && memberRoleMatch) {
      const conversationId = memberRoleMatch[1];
      const targetUserId = memberRoleMatch[2];
      const actor = getMembership(conversationId, auth.user.id);
      const target = getMembership(conversationId, targetUserId);
      if (!actor || !target) throw httpError(404, 'Участник не найден.');
      const selfLeave = targetUserId === auth.user.id;
      if (target.role === 'owner') throw httpError(400, 'Владелец не может покинуть группу без передачи владения.');
      if (!selfLeave && !['owner', 'admin'].includes(actor.role)) throw httpError(403, 'Нужны права администратора.');
      if (!selfLeave && actor.role === 'admin' && target.role !== 'member') throw httpError(403, 'Администратор не может удалить другого администратора.');
      db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(conversationId, targetUserId);
      broadcastConversation(conversationId, { type: 'conversation:updated', conversationId });
      sendToUser(targetUserId, { type: 'conversation:removed', conversationId });
      return sendEmpty(res, 204);
    }

    const pinMatch = url.pathname.match(/^\/conversations\/([^/]+)\/pin$/);
    if (req.method === 'POST' && pinMatch) {
      const conversationId = pinMatch[1];
      const membership = getMembership(conversationId, auth.user.id);
      if (!membership) throw httpError(403, 'Нет доступа к чату.');
      const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
      if (conversation.kind === 'group' && !['owner', 'admin'].includes(membership.role)) throw httpError(403, 'Закреплять сообщения могут администраторы.');
      const body = await readJson(req);
      const messageId = body.messageId ? String(body.messageId) : null;
      if (messageId) {
        const message = db.prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL').get(messageId, conversationId);
        if (!message) throw httpError(404, 'Сообщение для закрепления не найдено.');
      }
      db.prepare('UPDATE conversations SET pinned_message_id = ? WHERE id = ?').run(messageId, conversationId);
      broadcastConversation(conversationId, { type: 'conversation:updated', conversationId });
      return json(res, 200, { conversation: getConversationForUser(conversationId, auth.user.id) });
    }

    const searchMessagesMatch = url.pathname.match(/^\/conversations\/([^/]+)\/search$/);
    if (req.method === 'GET' && searchMessagesMatch) {
      const conversationId = searchMessagesMatch[1];
      if (!isMember(conversationId, auth.user.id)) throw httpError(403, 'Нет доступа к чату.');
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) return json(res, 200, { messages: [] });
      const rows = db.prepare(`${messageSelectSql()} WHERE m.conversation_id = ? AND m.deleted_at IS NULL AND m.body LIKE ? ORDER BY m.created_at DESC LIMIT 50`)
        .all(conversationId, `%${q}%`);
      return json(res, 200, { messages: rows.map((row) => serializeMessage(row, auth.user.id)) });
    }


    const notificationMatch = url.pathname.match(/^\/conversations\/([^/]+)\/notifications$/);
    if (req.method === 'PATCH' && notificationMatch) {
      const conversationId = notificationMatch[1];
      if (!isMember(conversationId, auth.user.id)) throw httpError(403, 'Нет доступа к чату.');
      const body = await readJson(req);
      const muted = Boolean(body.muted);
      const muteUntil = muted ? new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString() : null;
      db.prepare('UPDATE conversation_members SET muted_until = ? WHERE conversation_id = ? AND user_id = ?')
        .run(muteUntil, conversationId, auth.user.id);
      return json(res, 200, { conversation: getConversationForUser(conversationId, auth.user.id) });
    }

    const inviteMatch = url.pathname.match(/^\/conversations\/([^/]+)\/invite$/);
    if (inviteMatch && req.method === 'GET') {
      const conversationId = inviteMatch[1];
      requireShareRole(conversationId, auth.user.id, ['owner', 'admin']);
      const invite = db.prepare('SELECT token, created_at, expires_at, uses, revoked_at FROM group_invites WHERE conversation_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1')
        .get(conversationId, new Date().toISOString());
      return json(res, 200, { invite: invite ? serializeInvite(invite) : null });
    }
    if (inviteMatch && req.method === 'POST') {
      const conversationId = inviteMatch[1];
      requireShareRole(conversationId, auth.user.id, ['owner', 'admin']);
      const body = await readJson(req);
      const requestedHours = Number(body.hours ?? 24 * 7);
      if (!Number.isFinite(requestedHours)) throw httpError(400, 'Некорректный срок приглашения.');
      const hours = Math.min(24 * 30, Math.max(1, requestedHours));
      const now = new Date();
      db.prepare('UPDATE group_invites SET revoked_at = ? WHERE conversation_id = ? AND revoked_at IS NULL').run(now.toISOString(), conversationId);
      const token = crypto.randomBytes(18).toString('base64url');
      const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO group_invites (token, conversation_id, created_by, created_at, expires_at, uses) VALUES (?, ?, ?, ?, ?, 0)')
        .run(token, conversationId, auth.user.id, now.toISOString(), expiresAt);
      const invite = db.prepare('SELECT token, created_at, expires_at, uses, revoked_at FROM group_invites WHERE token = ?').get(token);
      return json(res, 201, { invite: serializeInvite(invite) });
    }
    if (inviteMatch && req.method === 'DELETE') {
      const conversationId = inviteMatch[1];
      requireShareRole(conversationId, auth.user.id, ['owner', 'admin']);
      db.prepare('UPDATE group_invites SET revoked_at = ? WHERE conversation_id = ? AND revoked_at IS NULL')
        .run(new Date().toISOString(), conversationId);
      return sendEmpty(res, 204);
    }

    const joinInviteMatch = url.pathname.match(/^\/invites\/([^/]+)\/join$/);
    if (req.method === 'POST' && joinInviteMatch) {
      assertRateLimit(`invite-join:${auth.user.id}`, 12, 60_000);
      const token = joinInviteMatch[1];
      const invite = db.prepare(`SELECT gi.*, c.kind, c.is_channel, c.discussion_conversation_id FROM group_invites gi JOIN conversations c ON c.id = gi.conversation_id WHERE gi.token = ?`).get(token);
      const now = new Date().toISOString();
      if (!invite || invite.revoked_at || (invite.expires_at && invite.expires_at <= now)) throw httpError(404, 'Ссылка-приглашение недействительна или истекла.');
      if (invite.kind !== 'group') throw httpError(400, 'Эта ссылка недействительна.');
      const alreadyMember = isMember(invite.conversation_id, auth.user.id);
      if (!alreadyMember) {
        const memberCount = Number(db.prepare('SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id = ?').get(invite.conversation_id).count || 0);
        const memberLimit = invite.is_channel ? 10000 : 100;
        if (memberCount >= memberLimit) throw httpError(409, invite.is_channel ? 'Канал достиг лимита подписчиков этой MVP-версии.' : 'В этой версии группа уже достигла лимита в 100 участников.');
        db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, 'member', ?, ?)`)
          .run(invite.conversation_id, auth.user.id, now, now);
        if (invite.is_channel && invite.discussion_conversation_id) {
          db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, 'member', ?, ?)`)
            .run(invite.discussion_conversation_id, auth.user.id, now, now);
        }
        db.prepare('UPDATE group_invites SET uses = uses + 1 WHERE token = ?').run(token);
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, invite.conversation_id);
      }
      broadcastConversation(invite.conversation_id, { type: 'conversation:updated', conversationId: invite.conversation_id });
      return json(res, 200, { conversation: getConversationForUser(invite.conversation_id, auth.user.id) });
    }

    const blockMatch = url.pathname.match(/^\/users\/([^/]+)\/block$/);
    if (blockMatch && req.method === 'POST') {
      const username = normalizeUsername(decodeURIComponent(blockMatch[1]));
      const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!target) throw httpError(404, 'Пользователь не найден.');
      if (target.id === auth.user.id) throw httpError(400, 'Нельзя заблокировать самого себя.');
      db.prepare('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
        .run(auth.user.id, target.id, new Date().toISOString());
      sendToUser(target.id, { type: 'privacy:updated', userId: auth.user.id });
      return json(res, 200, { blocked: true });
    }
    if (blockMatch && req.method === 'DELETE') {
      const username = normalizeUsername(decodeURIComponent(blockMatch[1]));
      const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!target) throw httpError(404, 'Пользователь не найден.');
      db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(auth.user.id, target.id);
      sendToUser(target.id, { type: 'privacy:updated', userId: auth.user.id });
      return json(res, 200, { blocked: false });
    }

    if (route === 'GET /blocks') {
      const users = db.prepare(`SELECT u.* FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`)
        .all(auth.user.id).map(publicUser);
      return json(res, 200, { users });
    }

    if (route === 'POST /reports') {
      assertRateLimit(`reports:${auth.user.id}`, 8, 60 * 60_000);
      const body = await readJson(req);
      const reason = String(body.reason || '').trim();
      const details = String(body.details || '').trim();
      const conversationId = body.conversationId ? String(body.conversationId) : null;
      const messageId = body.messageId ? String(body.messageId) : null;
      const targetUserId = body.targetUserId ? String(body.targetUserId) : null;
      if (!['spam', 'harassment', 'violence', 'sexual', 'other'].includes(reason)) throw httpError(400, 'Выбери причину жалобы.');
      if (details.length > 1000) throw httpError(400, 'Комментарий к жалобе — максимум 1000 символов.');
      if (conversationId && !isMember(conversationId, auth.user.id)) throw httpError(403, 'Нет доступа к указанному чату.');
      if (messageId) {
        const message = db.prepare('SELECT conversation_id, sender_id FROM messages WHERE id = ?').get(messageId);
        if (!message || !isMember(message.conversation_id, auth.user.id)) throw httpError(404, 'Сообщение не найдено.');
      }
      if (targetUserId && !getUserById(targetUserId)) throw httpError(404, 'Пользователь не найден.');
      db.prepare('INSERT INTO reports (id, reporter_id, target_user_id, conversation_id, message_id, reason, details, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), auth.user.id, targetUserId, conversationId, messageId, reason, details, new Date().toISOString(), 'open');
      return json(res, 201, { ok: true });
    }

    if (route === 'POST /uploads/init') {
      assertRateLimit(`upload-init:${auth.user.id}`, 60, 60_000);
      const body = await readJson(req);
      const fileName = safeFileName(body.fileName || 'file');
      const mimeType = String(body.mimeType || 'application/octet-stream').slice(0, 200);
      const pending = db.prepare("SELECT COUNT(*) AS n FROM upload_sessions WHERE user_id = ? AND status IN ('uploading','assembling') AND expires_at > ?").get(auth.user.id, new Date().toISOString());
      if (pending.n >= 8) throw httpError(429, 'Заверши текущие загрузки перед началом новых.');
      const size = Number(body.size || 0);
      const chunkSize = Math.floor(Math.max(256 * 1024, Math.min(MAX_UPLOAD_CHUNK_BYTES, Number(body.chunkSize || 1024 * 1024) || 1024 * 1024)));
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_RESUMABLE_BYTES) throw httpError(400, `Размер resumable upload должен быть от 1 байта до ${Math.round(MAX_RESUMABLE_BYTES / 1024 / 1024)} МБ.`);
      const totalChunks = Math.ceil(size / chunkSize);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      fs.mkdirSync(path.join(uploadPartsPath, id), { recursive: true });
      db.prepare(`INSERT INTO upload_sessions (id, user_id, file_name, mime_type, size, chunk_size, total_chunks, created_at, updated_at, expires_at, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`)
        .run(id, auth.user.id, fileName, mimeType, size, chunkSize, totalChunks, now, now, new Date(Date.now() + 24 * 60 * 60_000).toISOString());
      return json(res, 201, { upload: serializeUploadSession(db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id), []) });
    }

    const uploadStatusMatch = url.pathname.match(/^\/uploads\/([^/]+)\/status$/);
    if (uploadStatusMatch && req.method === 'GET') {
      const row = db.prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?').get(uploadStatusMatch[1], auth.user.id);
      if (!row) throw httpError(404, 'Upload session не найдена.');
      const chunks = db.prepare('SELECT chunk_index FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index').all(row.id).map((x) => Number(x.chunk_index));
      return json(res, 200, { upload: serializeUploadSession(row, chunks) });
    }

    const uploadChunkMatch = url.pathname.match(/^\/uploads\/([^/]+)\/chunks\/(\d+)$/);
    if (uploadChunkMatch && req.method === 'PUT') {
      assertRateLimit(`upload-chunk:${auth.user.id}`, 240, 60_000);
      const uploadId = uploadChunkMatch[1];
      const chunkIndex = Number(uploadChunkMatch[2]);
      const upload = db.prepare(`SELECT * FROM upload_sessions WHERE id = ? AND user_id = ? AND status = 'uploading'`).get(uploadId, auth.user.id);
      if (!upload) throw httpError(404, 'Upload session не найдена или уже завершена.');
      if (new Date(upload.expires_at).getTime() < Date.now()) throw httpError(410, 'Upload session истекла.');
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= Number(upload.total_chunks)) throw httpError(400, 'Некорректный номер chunk.');
      const expected = chunkIndex === Number(upload.total_chunks) - 1 ? Number(upload.size) - chunkIndex * Number(upload.chunk_size) : Number(upload.chunk_size);
      const buffer = await readBuffer(req, Math.min(MAX_UPLOAD_CHUNK_BYTES, Number(upload.chunk_size)) + 1024);
      if (buffer.length !== expected) throw httpError(400, `Неверный размер chunk: ожидалось ${expected}, получено ${buffer.length}.`);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      const chunkFile = path.join(uploadPartsPath, uploadId, `${chunkIndex}.part`);
      fs.mkdirSync(path.dirname(chunkFile), { recursive: true });
      if (!db.prepare("SELECT 1 FROM upload_sessions WHERE id = ? AND status = 'uploading'").get(uploadId)) throw httpError(409, 'Загрузка уже завершается.');
      await fs.promises.writeFile(chunkFile, buffer);
      db.prepare(`INSERT INTO upload_chunks (upload_id, chunk_index, size, sha256, received_at) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(upload_id, chunk_index) DO UPDATE SET size = excluded.size, sha256 = excluded.sha256, received_at = excluded.received_at`)
        .run(uploadId, chunkIndex, buffer.length, hash, new Date().toISOString());
      db.prepare('UPDATE upload_sessions SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), uploadId);
      const done = Number(db.prepare('SELECT COUNT(*) AS n FROM upload_chunks WHERE upload_id = ?').get(uploadId).n);
      return json(res, 200, { ok: true, receivedChunks: done, totalChunks: Number(upload.total_chunks), progress: Math.round(done / Number(upload.total_chunks) * 100) });
    }

    const uploadCompleteMatch = url.pathname.match(/^\/uploads\/([^/]+)\/complete$/);
    if (uploadCompleteMatch && req.method === 'POST') {
      const upload = db.prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?').get(uploadCompleteMatch[1], auth.user.id);
      if (!upload) throw httpError(404, 'Загрузка не найдена.');
      if (upload.status === 'completed') return json(res, 200, { media: mediaMetadata(db.prepare('SELECT * FROM media WHERE id = ?').get(upload.media_id)) });
      if (upload.status !== 'uploading') throw httpError(409, 'Загрузка уже завершается или отменена.');
      if (upload.expires_at < new Date().toISOString()) throw httpError(410, 'Загрузка истекла.');
      const chunks = db.prepare('SELECT chunk_index, size FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index').all(upload.id);
      if (chunks.length !== Number(upload.total_chunks)) throw httpError(409, `Загружено ${chunks.length}/${upload.total_chunks} частей.`);
      db.prepare("UPDATE upload_sessions SET status = 'assembling' WHERE id = ?").run(upload.id);
      const storageName = crypto.randomBytes(24).toString('hex');
      const finalPath = path.join(uploadsPath, storageName);
      let handle;
      try {
        handle = await fs.promises.open(finalPath, 'wx+');
        // At most one chunk resides in memory. File I/O yields to other requests.
        for (let index = 0; index < Number(upload.total_chunks); index++) {
          const part = await fs.promises.readFile(path.join(uploadPartsPath, upload.id, `${index}.part`));
          let offset = 0;
          while (offset < part.length) { const result = await handle.write(part, offset, part.length - offset); offset += result.bytesWritten; }
        }
        const stat = await handle.stat();
        if (stat.size !== Number(upload.size)) throw httpError(409, 'Размер собранного файла не совпадает.');
        const head = Buffer.alloc(32); await handle.read(head, 0, 32, 0);
        const mimeType = detectSafeMime(head, upload.mime_type);
        await handle.close(); handle = null;
        const mediaId = crypto.randomUUID(); const createdAt = new Date().toISOString();
        db.transaction(() => {
          db.prepare('INSERT INTO media (id, owner_id, file_name, mime_type, size, storage_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(mediaId, auth.user.id, upload.file_name, mimeType, upload.size, storageName, createdAt);
          db.prepare("UPDATE upload_sessions SET status = 'completed', media_id = ?, updated_at = ? WHERE id = ?").run(mediaId, createdAt, upload.id);
        })();
        await fs.promises.rm(path.join(uploadPartsPath, upload.id), { recursive: true, force: true });
        return json(res, 201, { media: { id: mediaId, fileName: upload.file_name, mimeType, size: Number(upload.size), createdAt } });
      } catch (error) {
        await handle?.close().catch(() => {});
        await fs.promises.rm(finalPath, { force: true });
        db.prepare("UPDATE upload_sessions SET status = 'uploading' WHERE id = ? AND status = 'assembling'").run(upload.id);
        throw error;
      }
    }

    const uploadDeleteMatch = url.pathname.match(/^\/uploads\/([^/]+)$/);
    if (uploadDeleteMatch && req.method === 'DELETE') {
      const upload = db.prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?').get(uploadDeleteMatch[1], auth.user.id);
      if (!upload) return sendEmpty(res, 204);
      if (upload.status === 'assembling') throw httpError(409, 'Подожди завершения сборки файла.');
      if (upload.status === 'completed') return sendEmpty(res, 204);
      db.prepare(`UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), upload.id);
      fs.rmSync(path.join(uploadPartsPath, upload.id), { recursive: true, force: true });
      return sendEmpty(res, 204);
    }

    if (route === 'POST /media') {
      assertRateLimit(`media:${auth.user.id}`, 20, 60_000);
      const fileName = safeFileName(decodeURIComponent(String(req.headers['x-file-name'] || 'file')));
      const declaredMime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
      const buffer = await readBuffer(req, MAX_UPLOAD_BYTES);
      const mimeType = detectSafeMime(buffer, declaredMime);
      if (!buffer.length) return json(res, 400, { error: 'EMPTY_FILE', message: 'Файл пустой.' });
      const id = crypto.randomUUID();
      const storageName = crypto.randomBytes(24).toString('hex');
      const createdAt = new Date().toISOString();
      await fs.promises.writeFile(path.join(uploadsPath, storageName), buffer);
      db.prepare(`
        INSERT INTO media (id, owner_id, file_name, mime_type, size, storage_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, auth.user.id, fileName, mimeType, buffer.length, storageName, createdAt);
      return json(res, 201, { media: { id, fileName, mimeType, size: buffer.length, createdAt } });
    }

    const mediaAccessMatch = url.pathname.match(/^\/media\/([^/]+)\/access$/);
    if (req.method === 'GET' && mediaAccessMatch) {
      const media = getAccessibleMedia(mediaAccessMatch[1], auth.user.id);
      if (!media) throw httpError(404, 'Файл не найден.');
      const ticket = crypto.randomBytes(24).toString('base64url');
      mediaTickets.set(ticket, { mediaId: media.id, sessionId: auth.sessionId, userId: auth.user.id, expiresAt: Date.now() + 30 * 60_000 });
      return json(res, 200, { path: `/media/${media.id}?access=${ticket}` });
    }

    const mediaMatch = url.pathname.match(/^\/media\/([^/]+)$/);
    if (req.method === 'GET' && mediaMatch) {
      const media = getAccessibleMedia(mediaMatch[1], auth.user.id);
      if (!media) return json(res, 404, { error: 'MEDIA_NOT_FOUND', message: 'Файл не найден.' });
      const filePath = path.join(uploadsPath, media.storage_name);
      if (!fs.existsSync(filePath)) return json(res, 404, { error: 'MEDIA_MISSING', message: 'Файл отсутствует в хранилище.' });
      const stat = await fs.promises.stat(filePath);
      let start = 0; let end = stat.size - 1; let status = 200;
      if (req.headers.range) {
        const match = String(req.headers.range).match(/^bytes=(\d*)-(\d*)$/);
        if (!match || (!match[1] && !match[2])) { res.setHeader('Content-Range', `bytes */${stat.size}`); return sendEmpty(res, 416); }
        if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { res.setHeader('Content-Range', `bytes */${stat.size}`); return sendEmpty(res, 416); }
        status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      res.writeHead(status, {
        'Content-Type': media.mime_type, 'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `${inlineMime(media.mime_type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(media.file_name)}`,
        'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
      return;
    }

    const galleryMatch = url.pathname.match(/^\/conversations\/([^/]+)\/media$/);
    if (req.method === 'GET' && galleryMatch) {
      const conversationId = galleryMatch[1];
      if (!isMember(conversationId, auth.user.id)) return json(res, 403, { error: 'FORBIDDEN' });
      const before = url.searchParams.get('before');
      const limit = Math.max(12, Math.min(100, Number(url.searchParams.get('limit') || 60) || 60));
      const params = [conversationId];
      let beforeSql = '';
      if (before) { const c = decodePageCursor(before); beforeSql = 'AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))'; params.push(c.at, c.at, c.id); }
      params.push(limit + 1);
      const rows = db.prepare(`
        SELECT m.id AS message_id, m.created_at, m.sender_id, u.display_name AS sender_display_name,
               md.id, md.file_name, md.mime_type, md.size
        FROM messages m
        JOIN media md ON md.id = m.attachment_id
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ? AND m.deleted_at IS NULL ${beforeSql}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?
      `).all(...params);
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const items = pageRows.map((row) => ({
        id: row.id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        size: Number(row.size || 0),
        messageId: row.message_id,
        createdAt: row.created_at,
        senderId: row.sender_id,
        senderDisplayName: row.sender_display_name
      }));
      return json(res, 200, { items, hasMore, nextCursor: hasMore && pageRows.length ? encodePageCursor(pageRows.at(-1).created_at, pageRows.at(-1).message_id) : null });
    }

    const messagesMatch = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
    if (req.method === 'GET' && messagesMatch) {
      const conversationId = messagesMatch[1];
      if (!isMember(conversationId, auth.user.id)) return json(res, 403, { error: 'FORBIDDEN' });
      const before = url.searchParams.get('before');
      const limit = Math.max(10, Math.min(100, Number(url.searchParams.get('limit') || 50) || 50));
      const page = getMessagesPage(conversationId, auth.user.id, before, limit);
      trackChannelViews(conversationId, auth.user.id, page.messages);
      const refreshed = isChannel(conversationId) ? getMessagesPage(conversationId, auth.user.id, before, limit) : page;
      return json(res, 200, refreshed);
    }

    if (req.method === 'POST' && messagesMatch) {
      const conversationId = messagesMatch[1];
      assertRateLimit(`messages:${auth.user.id}`, 60, 60_000);
      if (!isMember(conversationId, auth.user.id)) return json(res, 403, { error: 'FORBIDDEN' });
      assertCanMessage(conversationId, auth.user.id);
      const body = await readJson(req);
      const clientRequestId = normalizeClientRequestId(body?.clientRequestId);
      if (clientRequestId) {
        const existing = getMessageByClientRequest(auth.user.id, clientRequestId);
        if (existing) { if (existing.conversationId !== conversationId) throw httpError(409, 'clientRequestId уже использован в другом чате.'); return json(res, 200, { message: existing, deduplicated: true }); }
      }
      const message = createMessage(conversationId, auth.user.id, { ...body, clientRequestId });
      emitMessageSideEffects(message, auth.user.id);
      broadcastConversation(conversationId, { type: 'message:new', message });
      return json(res, 201, { message, deduplicated: false });
    }

    const forwardMatch = url.pathname.match(/^\/messages\/([^/]+)\/forward$/);
    if (req.method === 'POST' && forwardMatch) {
      assertRateLimit(`forward:${auth.user.id}`, 50, 60_000);
      const source = db.prepare('SELECT * FROM messages WHERE id = ?').get(forwardMatch[1]);
      if (!source || source.deleted_at || !isMember(source.conversation_id, auth.user.id)) throw httpError(404, 'Исходное сообщение не найдено.');
      const body = await readJson(req);
      const targetConversationId = String(body.conversationId || '');
      if (!isMember(targetConversationId, auth.user.id)) throw httpError(403, 'Нет доступа к целевому чату.');
      assertCanMessage(targetConversationId, auth.user.id);
      const message = forwardMessage(source, targetConversationId, auth.user.id);
      emitMessageSideEffects(message, auth.user.id);
      broadcastConversation(targetConversationId, { type: 'message:new', message });
      return json(res, 201, { message });
    }

    const messageMatch = url.pathname.match(/^\/messages\/([^/]+)$/);
    if (req.method === 'GET' && messageMatch) {
      const raw = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(messageMatch[1]);
      if (!raw || !isMember(raw.conversation_id, auth.user.id)) throw httpError(404, 'Сообщение не найдено.');
      return json(res, 200, { message: getMessageById(messageMatch[1], auth.user.id) });
    }
    if (req.method === 'PATCH' && messageMatch) {
      const message = updateMessage(messageMatch[1], auth.user.id, await readJson(req));
      broadcastConversation(message.conversationId, { type: 'message:updated', message });
      return json(res, 200, { message });
    }

    if (req.method === 'DELETE' && messageMatch) {
      const message = deleteMessage(messageMatch[1], auth.user.id);
      broadcastConversation(message.conversationId, { type: 'message:deleted', message });
      return json(res, 200, { message });
    }

    const reactionMatch = url.pathname.match(/^\/messages\/([^/]+)\/reactions$/);
    if (req.method === 'POST' && reactionMatch) {
      const messageId = reactionMatch[1];
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!existing || !isMember(existing.conversation_id, auth.user.id)) throw httpError(404, 'Сообщение не найдено.');
      if (existing.deleted_at) throw httpError(400, 'Нельзя реагировать на удалённое сообщение.');
      const body = await readJson(req);
      const emoji = String(body.emoji || '').trim();
      const allowed = new Set(['👍','❤️','🔥','😂','😮','😢']);
      if (!allowed.has(emoji)) throw httpError(400, 'Эта реакция пока не поддерживается.');
      const exists = db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(messageId, auth.user.id, emoji);
      if (exists) db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, auth.user.id, emoji);
      else db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(messageId, auth.user.id, emoji, new Date().toISOString());
      const message = getMessageById(messageId, auth.user.id);
      if (!exists && existing.sender_id !== auth.user.id) createActivity(existing.sender_id, 'reaction', auth.user.id, existing.conversation_id, messageId, { emoji });
      broadcastConversation(existing.conversation_id, { type: 'message:reaction', conversationId: existing.conversation_id, messageId });
      return json(res, 200, { message });
    }

    const readMatch = url.pathname.match(/^\/conversations\/([^/]+)\/read$/);
    if (req.method === 'POST' && readMatch) {
      const conversationId = readMatch[1];
      if (!isMember(conversationId, auth.user.id)) return json(res, 403, { error: 'FORBIDDEN' });
      const now = new Date().toISOString();
      db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?')
        .run(now, conversationId, auth.user.id);
      if (getUserById(auth.user.id)?.read_receipts !== 0) {
        broadcastConversation(conversationId, { type: 'conversation:read', conversationId, userId: auth.user.id, at: now }, auth.user.id);
      }
      return sendEmpty(res, 204);
    }

    return json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    if (!error?.statusCode || error.statusCode >= 500) console.error('Request failed:', error.message);
    const status = error?.statusCode || 500;
    if (error?.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    return json(res, status, { error: 'REQUEST_FAILED', message: status === 500 ? 'Внутренняя ошибка сервера.' : error.message });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
const sessionDisconnectTimers = new Map();
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws') return socket.destroy();
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) return socket.destroy();
    const token = url.searchParams.get('token') || '';
    const session = getSessionByToken(token);
    if (!session) return socket.destroy();

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = session.user.id;
      ws.sessionId = session.sessionId;
      wss.emit('connection', ws, req);
    });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const reconnectTimer = sessionDisconnectTimers.get(ws.sessionId);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    sessionDisconnectTimers.delete(ws.sessionId);
  }
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  addUserSocket(ws.userId, ws);
  touchSession(ws.sessionId);
  broadcastPresence(ws.userId, true);
  ws.send(JSON.stringify({ type: 'ready', userId: ws.userId }));

  const onlinePeers = db.prepare(`
    SELECT DISTINCT cm2.user_id
    FROM conversation_members cm1
    JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
    WHERE cm1.user_id = ? AND cm2.user_id != ?
  `).all(ws.userId, ws.userId);
  for (const peer of onlinePeers) {
    if (isBlockedEitherWay(ws.userId, peer.user_id) || !canSeePresence(ws.userId, peer.user_id)) continue;
    if (userSockets.get(peer.user_id)?.size) {
      ws.send(JSON.stringify({ type: 'presence', userId: peer.user_id, online: true }));
    }
  }

  ws.on('message', (raw) => {
    try {
      const validSession = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?').get(ws.sessionId, new Date().toISOString());
      if (!validSession) return ws.close(4001, 'Session expired');
      assertRateLimit(`ws:${ws.userId}`, 600, 60_000);
      const payload = JSON.parse(raw.toString());
      if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return;
      touchSession(ws.sessionId);

      if (payload.type === 'room:join') {
        assertRateLimit(`room-join:${ws.userId}`, 20, 60_000);
        const conversationId = String(payload.conversationId || '');
        const roomMode = payload.mode === 'video' ? 'video' : 'audio';
        const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        if (!conversation || conversation.kind !== 'group' || conversation.is_channel || conversation.is_discussion || !isMember(conversationId, ws.userId)) {
          return sendSocket(ws, { type: 'room:failed', message: 'Голосовая комната доступна только участникам обычной группы.' });
        }
        if (activeCallForUser(ws.userId)) return sendSocket(ws, { type: 'room:failed', message: 'Сначала заверши текущий личный звонок.' });
        const existingForUser = voiceRoomByUser.get(ws.userId);
        if (existingForUser) {
          const existingRoom = activeVoiceRooms.get(existingForUser.roomId);
          if (existingRoom && existingRoom.conversationId !== conversationId) return sendSocket(ws, { type: 'room:failed', message: 'Ты уже находишься в другой голосовой комнате.' });
          if (existingRoom && existingForUser.sessionId !== ws.sessionId) return sendSocket(ws, { type: 'room:failed', message: 'Голосовая комната уже открыта на другом устройстве.' });
          if (existingRoom) {
            return sendSocket(ws, { type: 'room:joined', room: serializeLiveVoiceRoom(existingRoom), selfUserId: ws.userId });
          }
        }

        let room = voiceRoomForConversation(conversationId);
        if (!room) room = createVoiceRoom(conversationId, ws.userId, roomMode);
        if (room.mode !== roomMode) return sendSocket(ws, { type: 'room:failed', message: room.mode === 'video' ? 'В этой группе уже идёт видеокомната.' : 'В этой группе уже идёт голосовая комната.' });
        const roomLimit = room.mode === 'video' ? 6 : 8;
        if (room.participants.size >= roomLimit) return sendSocket(ws, { type: 'room:failed', message: `Комната сейчас рассчитана максимум на ${roomLimit} участников.` });
        const joinedAt = new Date().toISOString();
        room.participants.set(ws.userId, { userId: ws.userId, sessionId: ws.sessionId, joinedAt });
        voiceRoomByUser.set(ws.userId, { roomId: room.id, sessionId: ws.sessionId });
        db.prepare(`INSERT INTO voice_room_participants (room_id, user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)`)
          .run(room.id, ws.userId, joinedAt);
        sendSocket(ws, { type: 'room:joined', room: serializeLiveVoiceRoom(room), selfUserId: ws.userId });
        for (const participant of room.participants.values()) {
          if (participant.userId === ws.userId) continue;
          sendToSession(participant.sessionId, { type: 'room:participant-joined', roomId: room.id, participant: serializeVoiceParticipant(ws.userId, joinedAt) });
        }
        return;
      }

      if (payload.type === 'room:leave') {
        leaveVoiceRoomForSession(ws.sessionId, ws.userId, 'left');
        return;
      }

      if (payload.type === 'room:offer' || payload.type === 'room:answer' || payload.type === 'room:ice') {
        const roomId = String(payload.roomId || '');
        const targetUserId = String(payload.targetUserId || '');
        const room = activeVoiceRooms.get(roomId);
        if (!room) return;
        const sender = room.participants.get(ws.userId);
        const target = room.participants.get(targetUserId);
        if (!sender || sender.sessionId !== ws.sessionId || !target || target.userId === ws.userId) return;
        const relay = { type: payload.type, roomId, fromUserId: ws.userId };
        if (payload.type === 'room:offer' || payload.type === 'room:answer') relay.sdp = payload.sdp;
        if (payload.type === 'room:ice') relay.candidate = payload.candidate;
        sendToSession(target.sessionId, relay);
        return;
      }

      if (payload.type === 'call:start') {
        assertRateLimit(`call-start:${ws.userId}`, 12, 60_000);
        const conversationId = String(payload.conversationId || '');
        const mode = payload.mode === 'video' ? 'video' : 'audio';
        const peer = getCallablePeer(conversationId, ws.userId);
        if (!peer) return sendSocket(ws, { type: 'call:failed', reason: 'invalid', message: 'Звонок доступен только в личном чате.' });
        if (!canUserCallPeer(ws.userId, peer.id)) return sendSocket(ws, { type: 'call:failed', reason: 'privacy', message: 'Пользователь ограничил входящие звонки настройками приватности.' });
        if (activeCallForUser(ws.userId) || voiceRoomByUser.has(ws.userId)) return sendSocket(ws, { type: 'call:failed', reason: 'busy', message: 'У тебя уже есть активный звонок или голосовая комната.' });
        if (activeCallForUser(peer.id) || voiceRoomByUser.has(peer.id)) return sendSocket(ws, { type: 'call:failed', reason: 'busy', message: `${peer.display_name} сейчас занят.` });

        const now = new Date().toISOString();
        const callId = crypto.randomUUID();
        const online = Boolean(userSockets.get(peer.id)?.size);
        const status = online ? 'ringing' : 'missed';
        db.prepare(`INSERT INTO calls (id, caller_id, callee_id, conversation_id, mode, status, started_at, ended_at, ended_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(callId, ws.userId, peer.id, conversationId, mode, status, now, online ? null : now, online ? null : 'system');
        const row = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
        if (!online) {
          return sendSocket(ws, { type: 'call:failed', reason: 'offline', message: 'Пользователь сейчас не в сети.', call: serializeCall(row, ws.userId) });
        }

        const live = { ...row, callerSessionId: ws.sessionId, calleeSessionId: null, timeout: null };
        live.timeout = setTimeout(() => {
          const current = activeCalls.get(callId);
          if (current?.status === 'ringing') finishCall(callId, 'system', 'missed', 'no_answer');
        }, 35_000);
        activeCalls.set(callId, live);
        sendSocket(ws, { type: 'call:outgoing', call: serializeCall(row, ws.userId) });
        sendToUser(peer.id, { type: 'call:incoming', call: serializeCall(row, peer.id) });
        return;
      }

      if (payload.type === 'call:accept') {
        const call = activeCalls.get(String(payload.callId || ''));
        if (!call || call.callee_id !== ws.userId || call.status !== 'ringing') return;
        clearTimeout(call.timeout);
        call.status = 'active';
        call.calleeSessionId = ws.sessionId;
        call.answered_at = new Date().toISOString();
        db.prepare(`UPDATE calls SET status = 'active', answered_at = ? WHERE id = ?`).run(call.answered_at, call.id);
        const callerPayload = { type: 'call:accepted', call: serializeCall(call, call.caller_id) };
        const calleePayload = { type: 'call:accepted', call: serializeCall(call, call.callee_id) };
        sendToSession(call.callerSessionId, callerPayload);
        sendSocket(ws, calleePayload);
        sendToUserExceptSession(call.callee_id, ws.sessionId, { type: 'call:dismiss', callId: call.id });
        return;
      }

      if (payload.type === 'call:reject') {
        const call = activeCalls.get(String(payload.callId || ''));
        if (!call || call.callee_id !== ws.userId || call.status !== 'ringing') return;
        finishCall(call.id, ws.userId, 'declined', 'declined');
        return;
      }

      if (payload.type === 'call:end') {
        const call = activeCalls.get(String(payload.callId || ''));
        if (!call || !isCallParticipant(call, ws.userId)) return;
        const status = call.status === 'ringing' && call.caller_id === ws.userId ? 'cancelled' : 'ended';
        finishCall(call.id, ws.userId, status, status);
        return;
      }

      if (payload.type === 'call:offer' || payload.type === 'call:answer' || payload.type === 'call:ice') {
        const call = activeCalls.get(String(payload.callId || ''));
        if (!call || call.status !== 'active' || !isCallParticipant(call, ws.userId)) return;
        const targetSession = ws.userId === call.caller_id ? call.calleeSessionId : call.callerSessionId;
        if (!targetSession) return;
        const relay = { type: payload.type, callId: call.id };
        if (payload.type === 'call:offer' || payload.type === 'call:answer') relay.sdp = payload.sdp;
        if (payload.type === 'call:ice') relay.candidate = payload.candidate;
        sendToSession(targetSession, relay);
        return;
      }

      if (payload.type === 'message:send') {
        const conversationId = String(payload.conversationId || '');
        assertRateLimit(`ws-messages:${ws.userId}`, 60, 60_000);
        if (!isMember(conversationId, ws.userId)) return;
        assertCanMessage(conversationId, ws.userId);
        const clientRequestId = normalizeClientRequestId(payload.clientRequestId);
        const existing = clientRequestId ? getMessageByClientRequest(ws.userId, clientRequestId) : null;
        if (existing) {
          if (existing.conversationId !== conversationId) throw httpError(409, 'clientRequestId уже использован в другом чате.');
          sendSocket(ws, { type: 'message:ack', clientRequestId, message: existing, deduplicated: true });
          return;
        }
        const message = createMessage(conversationId, ws.userId, { ...payload, clientRequestId });
        emitMessageSideEffects(message, ws.userId);
        broadcastConversation(conversationId, { type: 'message:new', message });
        sendSocket(ws, { type: 'message:ack', clientRequestId, message, deduplicated: false });
        return;
      }

      if (payload.type === 'typing') {
        const conversationId = String(payload.conversationId || '');
        if (!isMember(conversationId, ws.userId)) return;
        if (!canBroadcastTyping(conversationId, ws.userId)) return;
        broadcastConversation(conversationId, {
          type: 'typing',
          conversationId,
          userId: ws.userId,
          active: Boolean(payload.active)
        }, ws.userId);
      }
    } catch (error) {
      if (error?.statusCode === 429) ws.close(4008, 'Rate limited');
    }
  });

  ws.on('close', () => {
    removeUserSocket(ws.userId, ws);
    const previous = sessionDisconnectTimers.get(ws.sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      sessionDisconnectTimers.delete(ws.sessionId);
      const reconnected = [...(userSockets.get(ws.userId) || [])].some((socket) => socket.sessionId === ws.sessionId && socket.readyState === WebSocket.OPEN);
      if (reconnected) return;
      leaveVoiceRoomForSession(ws.sessionId, ws.userId, 'disconnected');
      endCallsForSession(ws.sessionId, ws.userId);
      if (!userSockets.get(ws.userId)?.size) broadcastPresence(ws.userId, false);
    }, 12_000);
    timer.unref?.();
    sessionDisconnectTimers.set(ws.sessionId, timer);
  });
});

processScheduledMessages();
const scheduledTimer = setInterval(processScheduledMessages, 5000);
scheduledTimer.unref?.();

const websocketHeartbeat = setInterval(() => {
  for (const sockets of userSockets.values()) {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        if (!socket.alive || !db.prepare('SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?').get(socket.sessionId, new Date().toISOString())) { socket.close(4001, 'Session expired'); continue; }
        socket.alive = false;
        try { socket.ping(); } catch { socket.terminate(); }
      }
    }
  }
}, 25_000);
websocketHeartbeat.unref?.();

server.listen(PORT, '0.0.0.0', () => {
  if (process.env.NODE_ENV === 'production' && !TURN_URL) console.warn('[RTC] TURN_URL is not configured; some internet calls may fail behind strict NAT.');
  console.log(`Messenger API v1.0: http://localhost:${PORT}`);
  console.log(`Messenger WS      : ws://localhost:${PORT}/ws`);
});


function getAccessibleMedia(mediaId, userId) {
      return db.prepare(`
        SELECT DISTINCT md.*
        FROM media md
        LEFT JOIN messages m ON m.attachment_id = md.id
        LEFT JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
        WHERE md.id = ? AND (
          md.owner_id = ? OR cm.user_id = ? OR
          EXISTS(SELECT 1 FROM users ux WHERE ux.avatar_media_id = md.id) OR
          EXISTS(SELECT 1 FROM conversations cx JOIN conversation_members ax ON ax.conversation_id = cx.id AND ax.user_id = ? WHERE cx.avatar_media_id = md.id)
        )
      `).get(userId, mediaId, userId, userId, userId);
}
function authenticateMediaTicket(req, url) {
  if (req.method !== 'GET') return null;
  const match = url.pathname.match(/^\/media\/([^/]+)$/);
  if (!match) return null;
  const ticket = mediaTickets.get(url.searchParams.get('access'));
  if (!ticket || ticket.mediaId !== match[1] || ticket.expiresAt < Date.now()) return null;
  if (!db.prepare('SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?').get(ticket.sessionId, new Date().toISOString()) || !getAccessibleMedia(ticket.mediaId, ticket.userId)) return null;
  return { user: getUserById(ticket.userId), sessionId: ticket.sessionId };
}
function mediaMetadata(row) { return row ? { id: row.id, fileName: row.file_name, mimeType: row.mime_type, size: Number(row.size), createdAt: row.created_at } : null; }
const maintenanceTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of mediaTickets) if (value.expiresAt < now) mediaTickets.delete(key);
  for (const map of [twoFactorLoginChallenges, twoFactorSetupChallenges, webauthnChallenges]) for (const [key, value] of map) if (value.expiresAt < now) map.delete(key);
  const expired = db.prepare("SELECT id FROM upload_sessions WHERE status IN ('uploading','cancelled') AND expires_at < ?").all(new Date(now).toISOString());
  for (const row of expired) { db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(row.id); void fs.promises.rm(path.join(uploadPartsPath, row.id), { recursive: true, force: true }).catch(() => {}); }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now).toISOString());
}, 60_000);
maintenanceTimer.unref();
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(scheduledTimer); clearInterval(websocketHeartbeat); clearInterval(maintenanceTimer);
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  server.close(() => { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('direct', 'group')),
      direct_key TEXT UNIQUE,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL,
      last_read_at TEXT,
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT
    );

    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id);
  `);

  ensureColumn('sessions', 'last_seen_at', 'TEXT');
  ensureColumn('sessions', 'user_agent', 'TEXT');
  ensureColumn('sessions', 'ip_address', 'TEXT');
  ensureColumn('messages', 'deleted_at', 'TEXT');
  ensureColumn('messages', 'reply_to_message_id', 'TEXT');
  ensureColumn('messages', 'attachment_id', 'TEXT');
  ensureColumn('users', 'bio', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'avatar_media_id', 'TEXT');
  ensureColumn('users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'two_factor_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'totp_secret_enc', 'TEXT');
  ensureColumn('users', 'last_totp_step', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn('users', 'recovery_codes_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'privacy_last_seen', "TEXT NOT NULL DEFAULT 'everyone'");
  ensureColumn('users', 'privacy_calls', "TEXT NOT NULL DEFAULT 'everyone'");
  ensureColumn('users', 'privacy_groups', "TEXT NOT NULL DEFAULT 'everyone'");
  ensureColumn('users', 'read_receipts', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('conversations', 'avatar_media_id', 'TEXT');
  ensureColumn('conversations', 'pinned_message_id', 'TEXT');
  ensureColumn('conversations', 'is_channel', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('conversations', 'public_username', 'TEXT');
  ensureColumn('conversations', 'description', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('conversations', 'discussion_conversation_id', 'TEXT');
  ensureColumn('conversations', 'is_discussion', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('conversation_members', 'muted_until', 'TEXT');
  ensureColumn('conversation_members', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('conversation_members', 'pinned_at', 'TEXT');
  ensureColumn('messages', 'channel_post_id', 'TEXT');
  ensureColumn('messages', 'forwarded_from_message_id', 'TEXT');
  ensureColumn('messages', 'client_request_id', 'TEXT');
  ensureColumn('messages', 'album_id', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);

    CREATE TABLE IF NOT EXISTS message_mentions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_user ON message_mentions(user_id, message_id);

    CREATE TABLE IF NOT EXISTS group_invites (
      token TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      uses INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invites_conversation ON group_invites(conversation_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON user_blocks(blocked_id);

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_public_username
      ON conversations(public_username) WHERE public_username IS NOT NULL;

    CREATE TABLE IF NOT EXISTS channel_post_views (
      post_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_views_post ON channel_post_views(post_id);
    CREATE INDEX IF NOT EXISTS idx_channel_comments_post ON messages(channel_post_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_client_request ON messages(sender_id, client_request_id) WHERE client_request_id IS NOT NULL;


    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_user_created ON activity_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_user_unread ON activity_events(user_id, read_at);

    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      callee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      mode TEXT NOT NULL DEFAULT 'audio',
      status TEXT NOT NULL DEFAULT 'ringing',
      started_at TEXT NOT NULL,
      answered_at TEXT,
      ended_at TEXT,
      ended_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_calls_caller_started ON calls(caller_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_callee_started ON calls(callee_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS voice_rooms (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      started_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_voice_rooms_conversation ON voice_rooms(conversation_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS voice_room_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES voice_rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      left_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_voice_room_participants_room ON voice_room_participants(room_id, joined_at);
    CREATE INDEX IF NOT EXISTS idx_voice_room_participants_user ON voice_room_participants(user_id, joined_at DESC);

    CREATE TABLE IF NOT EXISTS push_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL DEFAULT 'android',
      device_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      attachment_id TEXT REFERENCES media(id) ON DELETE SET NULL,
      send_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(status, send_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_messages(user_id, status, send_at);

    CREATE TABLE IF NOT EXISTS sync_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_user_seq ON sync_events(user_id, seq);

    CREATE TABLE IF NOT EXISTS user_drafts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS chat_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_folders_user ON chat_folders(user_id, position);

    CREATE TABLE IF NOT EXISTS chat_folder_items (
      folder_id TEXT NOT NULL REFERENCES chat_folders(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      PRIMARY KEY (folder_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      chunk_size INTEGER NOT NULL,
      total_chunks INTEGER NOT NULL,
      media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'uploading',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions(user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS upload_chunks (
      upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (upload_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Passkey',
      credential_id TEXT NOT NULL UNIQUE,
      public_key_b64 TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports_json TEXT NOT NULL DEFAULT '[]',
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_logs(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      webhook_url TEXT,
      mini_app_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id, created_at DESC);
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_page_v1 ON messages(conversation_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_attachment ON messages(attachment_id);
    CREATE INDEX IF NOT EXISTS idx_drafts_chat ON user_drafts(conversation_id);
    CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?, ?)').run('1.0.0', new Date().toISOString());
  ensureColumn('push_devices', 'session_id', 'TEXT');
  ensureColumn('bots', 'mini_app_url', 'TEXT');
  ensureColumn('voice_rooms', 'mode', "TEXT NOT NULL DEFAULT 'audio'");
  db.prepare("UPDATE upload_sessions SET status = 'uploading' WHERE status = 'assembling'").run();
  db.prepare(`UPDATE calls SET status = 'ended', ended_at = COALESCE(ended_at, ?), ended_by = COALESCE(ended_by, 'system') WHERE status IN ('ringing','active')`).run(new Date().toISOString());
  db.prepare(`UPDATE voice_rooms SET ended_at = COALESCE(ended_at, ?) WHERE ended_at IS NULL`).run(new Date().toISOString());
  db.prepare(`UPDATE voice_room_participants SET left_at = COALESCE(left_at, ?) WHERE left_at IS NULL`).run(new Date().toISOString());
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureSavedConversation(userId) {
  const directKey = `saved:${userId}`;
  const existing = db.prepare('SELECT * FROM conversations WHERE direct_key = ?').get(directKey);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO conversations (id, kind, direct_key, title, created_at, updated_at) VALUES (?, 'direct', ?, 'Saved Messages', ?, ?)`)
      .run(id, directKey, now, now);
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)`)
      .run(id, userId, now, now);
  })();
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

function getConversations(userId) {
  const rows = db.prepare(`
    SELECT c.*, cm.last_read_at, cm.muted_until, cm.archived, cm.pinned_at,
      (SELECT CASE WHEN m.deleted_at IS NOT NULL THEN 'Сообщение удалено'
                   WHEN m.body != '' THEN m.body
                   WHEN m.attachment_id IS NOT NULL THEN '📎 Вложение'
                   ELSE '' END
       FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_at,
      (SELECT u.display_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender_name,
      (SELECT m.sender_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender_id,
      (SELECT COUNT(*) FROM messages m
        WHERE m.conversation_id = c.id
          AND m.sender_id != ?
          AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
      ) AS unread_count,
      (SELECT COUNT(*) FROM message_mentions mm
        JOIN messages mx ON mx.id = mm.message_id
        WHERE mx.conversation_id = c.id AND mm.user_id = ? AND mx.sender_id != ? AND mx.deleted_at IS NULL
          AND (cm.last_read_at IS NULL OR mx.created_at > cm.last_read_at)
      ) AS mention_count
    FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE cm.user_id = ? AND COALESCE(c.is_discussion, 0) = 0
    ORDER BY CASE WHEN cm.pinned_at IS NOT NULL THEN 0 ELSE 1 END, cm.pinned_at DESC,
             CASE WHEN c.direct_key = ? THEN 0 ELSE 1 END,
             COALESCE(last_message_at, c.updated_at) DESC
  `).all(userId, userId, userId, userId, `saved:${userId}`);

  return rows.map((row) => hydrateConversation(row, userId));
}

function getConversationForUser(conversationId, userId) {
  const row = db.prepare(`
    SELECT c.*, cm.last_read_at, cm.muted_until, cm.archived, cm.pinned_at,
      (SELECT CASE WHEN m.deleted_at IS NOT NULL THEN 'Сообщение удалено'
                   WHEN m.body != '' THEN m.body
                   WHEN m.attachment_id IS NOT NULL THEN '📎 Вложение'
                   ELSE '' END
       FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_at,
      (SELECT u.display_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender_name,
      (SELECT m.sender_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_sender_id,
      0 AS unread_count, 0 AS mention_count
    FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE c.id = ? AND cm.user_id = ?
  `).get(conversationId, userId);
  return row ? hydrateConversation(row, userId) : null;
}

function hydrateConversation(row, userId) {
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.created_at, u.bio, u.avatar_media_id, u.is_bot, cm.role
    FROM conversation_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id = ?
    ORDER BY u.username
  `).all(row.id).map((member) => ({ ...publicUser(member), role: member.role }));
  const saved = row.direct_key === `saved:${userId}`;
  const peer = !saved && row.kind === 'direct' ? members.find((member) => member.id !== userId) : null;
  const blockedByMe = Boolean(peer && db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').get(userId, peer.id));
  const blockedByOther = Boolean(peer && db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').get(peer.id, userId));
  const muteUntil = row.muted_until || null;
  const muted = Boolean(muteUntil && new Date(muteUntil).getTime() > Date.now());

  return {
    id: row.id,
    kind: row.is_channel ? 'channel' : row.kind,
    isSaved: saved,
    title: saved ? 'Saved Messages' : row.kind === 'direct' ? (peer?.displayName || peer?.username || 'Unknown') : (row.title || (row.is_channel ? 'Channel' : 'Group')),
    username: saved ? null : peer?.username || null,
    avatarMediaId: saved ? null : row.kind === 'direct' ? (peer?.avatarMediaId || null) : (row.avatar_media_id || null),
    members,
    myRole: members.find((member) => member.id === userId)?.role || 'member',
    description: row.description || '',
    publicUsername: row.public_username || null,
    subscriberCount: row.is_channel ? members.length : 0,
    discussionConversationId: row.discussion_conversation_id || null,
    pinnedMessageId: row.pinned_message_id || null,
    pinnedMessage: row.pinned_message_id ? getPinnedPreview(row.pinned_message_id) : null,
    lastMessage: row.last_message || null,
    lastMessageAt: row.last_message_at || null,
    lastMessageSenderName: row.last_sender_name || null,
    lastMessageSenderId: row.last_sender_id || null,
    lastReadAt: row.last_read_at || null,
    unreadCount: Number(row.unread_count || 0),
    mentionCount: Number(row.mention_count || 0),
    muted,
    muteUntil,
    archived: Boolean(row.archived),
    pinned: Boolean(row.pinned_at),
    pinnedAt: row.pinned_at || null,
    blockedByMe,
    blockedByOther,
    updatedAt: row.updated_at
  };
}

function createOrGetDirectConversation(a, b) {
  const directKey = [a, b].sort().join(':');
  const existing = db.prepare('SELECT * FROM conversations WHERE direct_key = ?').get(directKey);
  if (existing) return existing;

  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO conversations (id, kind, direct_key, created_at, updated_at) VALUES (?, 'direct', ?, ?, ?)`)
      .run(conversationId, directKey, now, now);
    const add = db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)`);
    add.run(conversationId, a, now, now);
    add.run(conversationId, b, now, now);
  });
  tx();
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
}

function createGroupConversation(ownerId, title, memberIds = []) {
  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO conversations (id, kind, title, created_at, updated_at) VALUES (?, 'group', ?, ?, ?)`)
      .run(conversationId, title, now, now);
    const add = db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, ?, ?, ?)`);
    add.run(conversationId, ownerId, 'owner', now, now);
    for (const userId of [...new Set(memberIds)].filter((id) => id !== ownerId)) add.run(conversationId, userId, 'member', now, now);
  })();
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
}

function createChannelConversation(ownerId, title, description = '', publicUsername = null) {
  const channelId = crypto.randomUUID();
  const discussionId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO conversations (id, kind, title, created_at, updated_at, is_channel, public_username, description, discussion_conversation_id) VALUES (?, 'group', ?, ?, ?, 1, ?, ?, ?)`)
      .run(channelId, title, now, now, publicUsername || null, description, discussionId);
    db.prepare(`INSERT INTO conversations (id, kind, title, created_at, updated_at, is_channel, description, is_discussion) VALUES (?, 'group', ?, ?, ?, 0, ?, 1)`)
      .run(discussionId, `${title} · Discussion`, now, now, `Комментарии канала ${title}`);
    const add = db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, ?, ?, ?)`);
    add.run(channelId, ownerId, 'owner', now, now);
    add.run(discussionId, ownerId, 'owner', now, now);
  })();
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(channelId);
}

function isChannel(conversationId) {
  return Boolean(db.prepare('SELECT 1 FROM conversations WHERE id = ? AND is_channel = 1').get(conversationId));
}

function requireChannelMember(channelId, userId) {
  const channel = db.prepare('SELECT * FROM conversations WHERE id = ? AND is_channel = 1').get(channelId);
  if (!channel) throw httpError(404, 'Канал не найден.');
  if (!isMember(channelId, userId)) throw httpError(403, 'Сначала подпишись на канал.');
  return channel;
}

function requireChannelRole(channelId, userId, roles) {
  const channel = db.prepare('SELECT * FROM conversations WHERE id = ? AND is_channel = 1').get(channelId);
  if (!channel) throw httpError(404, 'Канал не найден.');
  const membership = getMembership(channelId, userId);
  if (!membership || !roles.includes(membership.role)) throw httpError(403, 'Недостаточно прав для управления каналом.');
  return membership;
}

function subscribeToDiscussion(channel, userId) {
  if (!channel?.discussion_conversation_id) return;
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, 'member', ?, ?)`)
    .run(channel.discussion_conversation_id, userId, now, now);
}

function subscribeToChannel(channel, userId) {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at) VALUES (?, ?, 'member', ?, ?)`)
    .run(channel.id, userId, now, now);
  subscribeToDiscussion(channel, userId);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, channel.id);
}

function unsubscribeFromChannel(channel, userId) {
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(channel.id, userId);
  if (channel.discussion_conversation_id) db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(channel.discussion_conversation_id, userId);
}

function serializeChannelPreview(row) {
  return {
    id: row.id,
    title: row.title || 'Channel',
    publicUsername: row.public_username || null,
    description: row.description || '',
    avatarMediaId: row.avatar_media_id || null,
    subscriberCount: Number(row.subscriber_count || 0),
    subscribed: Boolean(row.subscribed)
  };
}

function trackChannelViews(conversationId, viewerId, messages) {
  if (!isChannel(conversationId)) return;
  const insert = db.prepare('INSERT OR IGNORE INTO channel_post_views (post_id, user_id, viewed_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const message of messages) {
      if (!message.deletedAt && message.senderId !== viewerId) insert.run(message.id, viewerId, now);
    }
  });
  tx();
}

function getMembership(conversationId, userId) {
  return db.prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId);
}

function requireGroupRole(conversationId, userId, roles) {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation || conversation.kind !== 'group' || conversation.is_channel) throw httpError(400, 'Это не группа.');
  const membership = getMembership(conversationId, userId);
  if (!membership || !roles.includes(membership.role)) throw httpError(403, 'Недостаточно прав.');
  return membership;
}

function requireShareRole(conversationId, userId, roles) {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation || conversation.kind !== 'group') throw httpError(400, 'Invite-ссылка недоступна для этого чата.');
  const membership = getMembership(conversationId, userId);
  if (!membership || !roles.includes(membership.role)) throw httpError(403, 'Недостаточно прав.');
  return membership;
}

function requireGroupOrChannelRole(conversationId, userId, roles) {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation || conversation.kind !== 'group') throw httpError(400, 'Этот чат не поддерживает роли.');
  const membership = getMembership(conversationId, userId);
  if (!membership || !roles.includes(membership.role)) throw httpError(403, 'Недостаточно прав.');
  return membership;
}

function getPinnedPreview(messageId) {
  const row = db.prepare(`SELECT m.id, m.body, m.deleted_at, u.display_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(messageId);
  if (!row || row.deleted_at) return null;
  return { id: row.id, body: row.body || 'Вложение', senderDisplayName: row.display_name };
}

function messageSelectSql() {
  return `
    SELECT m.*, u.username, u.display_name,
           md.file_name AS attachment_file_name,
           md.mime_type AS attachment_mime_type,
           md.size AS attachment_size,
           r.body AS reply_body,
           r.deleted_at AS reply_deleted_at,
           ru.display_name AS reply_sender_display_name
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN media md ON md.id = m.attachment_id
    LEFT JOIN messages r ON r.id = m.reply_to_message_id
    LEFT JOIN users ru ON ru.id = r.sender_id
  `;
}

function getMessagesPage(conversationId, viewerId, before, limit = 50) {
  const safeLimit = Math.max(10, Math.min(100, Number(limit) || 50));
  const cursor = decodePageCursor(before);
  const filter = cursor ? ' AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))' : '';
  const args = cursor ? [conversationId, cursor.at, cursor.at, cursor.id, safeLimit + 1] : [conversationId, safeLimit + 1];
  const rows = db.prepare(`${messageSelectSql()} WHERE m.conversation_id = ?${filter} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(...args);
  const hasMore = rows.length > safeLimit;
  const pageRows = rows.slice(0, safeLimit);
  const oldest = pageRows.at(-1);
  return { messages: pageRows.reverse().map((row) => serializeMessage(row, viewerId)), hasMore,
    nextCursor: hasMore && oldest ? encodePageCursor(oldest.created_at, oldest.id) : null };
}
function encodePageCursor(at, id) { return Buffer.from(JSON.stringify({ at, id })).toString('base64url'); }
function decodePageCursor(value) {
  if (!value) return null;
  if (/^\d{4}-\d\d-\d\dT/.test(value)) return { at: value, id: '' };
  try { const c = JSON.parse(Buffer.from(value, 'base64url').toString()); if (typeof c.at === 'string' && typeof c.id === 'string' && c.at.length < 40 && c.id.length < 100) return c; } catch {}
  throw httpError(400, 'Некорректный курсор страницы.');
}

function getMessages(conversationId, viewerId, before) {
  return getMessagesPage(conversationId, viewerId, before, 100).messages;
}

function normalizeClientRequestId(value) {
  const id = String(value || '').trim();
  if (!id) return null;
  if (id.length > 96 || !/^[a-zA-Z0-9:_-]+$/.test(id)) throw httpError(400, 'Некорректный clientRequestId.');
  return id;
}

function getMessageByClientRequest(senderId, clientRequestId) {
  if (!clientRequestId) return null;
  const row = db.prepare('SELECT id FROM messages WHERE sender_id = ? AND client_request_id = ?').get(senderId, clientRequestId);
  return row ? getMessageById(row.id, senderId) : null;
}

function createMessage(conversationId, senderId, payload) {
  const body = String(payload?.body || '').trim();
  const replyToId = payload?.replyToId ? String(payload.replyToId) : null;
  const attachmentId = payload?.attachmentId ? String(payload.attachmentId) : null;
  const channelPostId = payload?.channelPostId ? String(payload.channelPostId) : null;
  if (channelPostId && !db.prepare('SELECT 1 FROM messages p JOIN conversations c ON c.id = p.conversation_id WHERE p.id = ? AND c.discussion_conversation_id = ? AND p.deleted_at IS NULL').get(channelPostId, conversationId)) throw httpError(400, 'Публикация не относится к этой дискуссии.');
  const albumId = attachmentId ? normalizeClientRequestId(payload?.albumId) : null;
  const clientRequestId = normalizeClientRequestId(payload?.clientRequestId);
  const duplicate = clientRequestId ? getMessageByClientRequest(senderId, clientRequestId) : null;
  if (duplicate) { if (duplicate.conversationId !== conversationId) throw httpError(409, 'clientRequestId уже использован в другом чате.'); return duplicate; }

  if (!body && !attachmentId) throw httpError(400, 'Сообщение пустое.');
  if (body.length > 8000) throw httpError(400, 'Сообщение слишком длинное.');

  if (replyToId) {
    const reply = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(replyToId);
    if (!reply || reply.conversation_id !== conversationId) throw httpError(400, 'Сообщение для ответа не найдено в этом чате.');
  }

  if (attachmentId) {
    const media = db.prepare('SELECT * FROM media WHERE id = ? AND owner_id = ?').get(attachmentId, senderId);
    if (!media) throw httpError(400, 'Вложение не найдено или не принадлежит тебе.');
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, body, created_at, reply_to_message_id, attachment_id, channel_post_id, client_request_id, album_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, senderId, body, now, replyToId, attachmentId, channelPostId, clientRequestId, albumId);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?')
      .run(now, conversationId, senderId);
  })();
  indexMentions(id, conversationId, senderId, body);

  return getMessageById(id, senderId);
}

function forwardMessage(source, targetConversationId, senderId) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, body, created_at, attachment_id, forwarded_from_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, targetConversationId, senderId, source.body || '', now, source.attachment_id || null, source.id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, targetConversationId);
    db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(now, targetConversationId, senderId);
  })();
  indexMentions(id, targetConversationId, senderId, source.body || '');
  return getMessageById(id, senderId);
}

function updateMessage(messageId, userId, payload) {
  const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!existing) throw httpError(404, 'Сообщение не найдено.');
  if (existing.sender_id !== userId || !isMember(existing.conversation_id, userId)) throw httpError(403, 'Можно редактировать только свои сообщения в доступном чате.');
  assertCanMessage(existing.conversation_id, userId);
  if (existing.deleted_at) throw httpError(400, 'Удалённое сообщение нельзя редактировать.');
  const body = String(payload?.body || '').trim();
  if (!body && !existing.attachment_id) throw httpError(400, 'Текст сообщения пустой.');
  if (body.length > 8000) throw httpError(400, 'Сообщение слишком длинное.');
  const editedAt = new Date().toISOString();
  db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, editedAt, messageId);
  db.prepare('DELETE FROM message_mentions WHERE message_id = ?').run(messageId);
  indexMentions(messageId, existing.conversation_id, userId, body);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(editedAt, existing.conversation_id);
  return getMessageById(messageId, userId);
}

function deleteMessage(messageId, userId) {
  const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!existing) throw httpError(404, 'Сообщение не найдено.');
  if (!isMember(existing.conversation_id, userId)) throw httpError(403, 'Нет доступа к чату.');
  if (existing.sender_id !== userId) {
    const conversation = db.prepare('SELECT is_channel FROM conversations WHERE id = ?').get(existing.conversation_id);
    const membership = getMembership(existing.conversation_id, userId);
    if (!conversation?.is_channel || !membership || !['owner', 'admin'].includes(membership.role)) throw httpError(403, 'Можно удалить только своё сообщение.');
  }
  const deletedAt = new Date().toISOString();
  db.prepare(`UPDATE messages SET body = '', deleted_at = ?, edited_at = NULL, attachment_id = NULL WHERE id = ?`)
    .run(deletedAt, messageId);
  db.prepare('UPDATE conversations SET updated_at = ?, pinned_message_id = CASE WHEN pinned_message_id = ? THEN NULL ELSE pinned_message_id END WHERE id = ?')
    .run(deletedAt, messageId, existing.conversation_id);
  return getMessageById(messageId, userId);
}

function getMessageById(messageId, viewerId) {
  const row = db.prepare(`${messageSelectSql()} WHERE m.id = ?`).get(messageId);
  if (!row) return null;
  return serializeMessage(row, viewerId);
}

function serializeMessage(row, viewerId) {
  const otherRead = Boolean(db.prepare(`
    SELECT 1 FROM conversation_members cm JOIN users reader ON reader.id = cm.user_id
    WHERE reader.read_receipts != 0 AND cm.conversation_id = ? AND cm.user_id != ?
      AND cm.last_read_at IS NOT NULL AND cm.last_read_at >= ?
    LIMIT 1
  `).get(row.conversation_id, row.sender_id, row.created_at));

  const mentionsMe = Boolean(db.prepare('SELECT 1 FROM message_mentions WHERE message_id = ? AND user_id = ?').get(row.id, viewerId));

  const reactionRows = db.prepare(`
    SELECT emoji, COUNT(*) AS count,
      MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
    FROM message_reactions WHERE message_id = ?
    GROUP BY emoji ORDER BY MIN(created_at)
  `).all(viewerId, row.id);
  const viewsCount = Number(db.prepare('SELECT COUNT(*) AS count FROM channel_post_views WHERE post_id = ?').get(row.id)?.count || 0);
  const commentsCount = Number(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE channel_post_id = ? AND deleted_at IS NULL').get(row.id)?.count || 0);
  const forwarded = row.forwarded_from_message_id ? db.prepare(`SELECT m.id, m.body, m.deleted_at, u.display_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(row.forwarded_from_message_id) : null;

  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderUsername: row.username,
    senderDisplayName: row.display_name,
    body: row.deleted_at ? '' : row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    deletedAt: row.deleted_at || null,
    readByOther: row.sender_id === viewerId ? otherRead : false,
    mentionsMe,
    channelPostId: row.channel_post_id || null,
    albumId: row.album_id || null,
    viewsCount,
    commentsCount,
    forwardedFrom: forwarded ? { id: forwarded.id, senderDisplayName: forwarded.display_name, body: forwarded.deleted_at ? 'Сообщение удалено' : (forwarded.body || 'Вложение') } : null,
    replyTo: row.reply_to_message_id ? {
      id: row.reply_to_message_id,
      senderDisplayName: row.reply_sender_display_name || 'Unknown',
      body: row.reply_deleted_at ? 'Сообщение удалено' : (row.reply_body || 'Вложение')
    } : null,
    attachment: row.attachment_id ? {
      id: row.attachment_id,
      fileName: row.attachment_file_name,
      mimeType: row.attachment_mime_type,
      size: Number(row.attachment_size || 0)
    } : null,
    reactions: reactionRows.map((reaction) => ({ emoji: reaction.emoji, count: Number(reaction.count), mine: Boolean(reaction.mine) }))
  };
}


function activitySelectSql() {
  return `
    SELECT a.*, actor.username AS actor_username, actor.display_name AS actor_display_name,
           c.title AS conversation_title, c.kind AS conversation_kind, c.is_channel AS conversation_is_channel,
           m.body AS message_body, m.deleted_at AS message_deleted_at
    FROM activity_events a
    LEFT JOIN users actor ON actor.id = a.actor_id
    LEFT JOIN conversations c ON c.id = a.conversation_id
    LEFT JOIN messages m ON m.id = a.message_id
  `;
}

function serializeActivity(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch {}
  return {
    id: row.id,
    type: row.type,
    actor: row.actor_id ? { id: row.actor_id, username: row.actor_username || '', displayName: row.actor_display_name || 'Unknown' } : null,
    conversationId: row.conversation_id || null,
    conversationTitle: row.conversation_title || null,
    conversationKind: row.conversation_is_channel ? 'channel' : (row.conversation_kind || null),
    messageId: row.message_id || null,
    messagePreview: row.message_deleted_at ? 'Сообщение удалено' : (row.message_body || ''),
    payload,
    createdAt: row.created_at,
    readAt: row.read_at || null
  };
}

function createActivity(userId, type, actorId = null, conversationId = null, messageId = null, payload = {}) {
  if (!userId || userId === actorId) return null;
  if (actorId && isBlockedEitherWay(userId, actorId)) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO activity_events (id, user_id, type, actor_id, conversation_id, message_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, type, actorId, conversationId, messageId, JSON.stringify(payload || {}), now);
  const row = db.prepare(`${activitySelectSql()} WHERE a.id = ?`).get(id);
  const activity = serializeActivity(row);
  sendToUser(userId, { type: 'activity:new', activity });
  return activity;
}

function emitMessageSideEffects(message, senderId) {
  const raw = db.prepare('SELECT reply_to_message_id FROM messages WHERE id = ?').get(message.id);
  if (message.mentionsMe) { /* viewer-relative flag is irrelevant here */ }
  const mentions = db.prepare('SELECT user_id FROM message_mentions WHERE message_id = ?').all(message.id);
  for (const { user_id: userId } of mentions) createActivity(userId, 'mention', senderId, message.conversationId, message.id);
  if (raw?.reply_to_message_id) {
    const parent = db.prepare('SELECT sender_id FROM messages WHERE id = ?').get(raw.reply_to_message_id);
    if (parent?.sender_id && parent.sender_id !== senderId && !mentions.some((item) => item.user_id === parent.sender_id)) {
      createActivity(parent.sender_id, 'reply', senderId, message.conversationId, message.id, { replyToId: raw.reply_to_message_id });
    }
  }
  dispatchBotWebhooks(message, senderId);
  dispatchMessagePush(message, senderId);
}

function createBotToken(botId) {
  return `bot_${String(botId).replace(/-/g, '').slice(0, 10)}_${crypto.randomBytes(32).toString('base64url')}`;
}

function authenticateBot(req) {
  const value = String(req.headers.authorization || '');
  const token = value.startsWith('Bot ') ? value.slice(4).trim() : (value.startsWith('Bearer ') ? value.slice(7).trim() : '');
  if (!token) return null;
  const row = db.prepare(`SELECT b.*, u.*,
      b.id AS bot_id, b.user_id AS bot_user_id, b.owner_id AS bot_owner_id, b.webhook_url AS bot_webhook_url, b.mini_app_url AS bot_mini_app_url
    FROM bots b JOIN users u ON u.id = b.user_id WHERE b.token_hash = ?`).get(hashToken(token));
  if (!row) return null;
  return {
    bot: { id: row.bot_id, user_id: row.bot_user_id, owner_id: row.bot_owner_id, webhook_url: row.bot_webhook_url, mini_app_url: row.bot_mini_app_url },
    user: row
  };
}

function validateWebhookUrl(raw) {
  return validateExternalUrl(raw, { allowLocal: ALLOW_LOCAL_WEBHOOKS });
}

function serializeBot(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarMediaId: row.avatar_media_id || null,
    tokenPrefix: row.token_prefix,
    webhookUrl: row.webhook_url || null,
    miniAppUrl: row.mini_app_url || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function dispatchBotWebhooks(message, senderId) {
  const bots = db.prepare(`
    SELECT b.id, b.user_id, b.webhook_url, u.username
    FROM conversation_members cm
    JOIN bots b ON b.user_id = cm.user_id
    JOIN users u ON u.id = b.user_id
    WHERE cm.conversation_id = ? AND b.webhook_url IS NOT NULL AND b.user_id != ?
  `).all(message.conversationId, senderId);
  if (!bots.length) return;
  const update = JSON.stringify({
    updateId: crypto.randomUUID(),
    type: 'message',
    bot: null,
    message: {
      id: message.id,
      chatId: message.conversationId,
      sender: { id: message.senderId, username: message.senderUsername, displayName: message.senderDisplayName },
      text: message.body,
      createdAt: message.createdAt,
      replyTo: message.replyTo,
      attachment: message.attachment
    }
  });
  for (const bot of bots) {
    const payload = JSON.parse(update);
    payload.bot = { id: bot.user_id, username: bot.username };
    void postWebhook(bot.webhook_url, JSON.stringify(payload), { allowLocal: ALLOW_LOCAL_WEBHOOKS })
      .catch(() => {});
  }
}

function serializeInvite(row) {
  return {
    token: row.token,
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    uses: Number(row.uses || 0)
  };
}

function indexMentions(messageId, conversationId, senderId, body) {
  const names = [...new Set([...String(body || '').matchAll(/@([a-zA-Z0-9_]{3,24})/g)].map((m) => m[1].toLowerCase()))];
  if (!names.length) return;
  const placeholders = names.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT u.id FROM users u
    JOIN conversation_members cm ON cm.user_id = u.id
    WHERE cm.conversation_id = ? AND u.username IN (${placeholders}) AND u.id != ?
  `).all(conversationId, ...names, senderId);
  const insert = db.prepare('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)');
  for (const row of rows) insert.run(messageId, row.id);
}

function isBlockedEitherWay(a, b) {
  if (!a || !b || a === b) return false;
  return Boolean(db.prepare(`SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`).get(a, b, b, a));
}

function assertCanMessage(conversationId, senderId) {
  const conversation = db.prepare('SELECT kind, direct_key, is_channel FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation) throw httpError(404, 'Чат не найден.');
  if (conversation.is_channel) {
    const membership = getMembership(conversationId, senderId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) throw httpError(403, 'Публиковать в канале могут только владелец и администраторы.');
    return;
  }
  if (conversation.kind !== 'direct' || String(conversation.direct_key || '').startsWith('saved:')) return;
  const peer = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ? LIMIT 1').get(conversationId, senderId);
  if (peer && isBlockedEitherWay(senderId, peer.user_id)) throw httpError(403, 'Нельзя отправлять сообщения: один из пользователей заблокировал другого.');
}

function canBroadcastTyping(conversationId, senderId) {
  if (isChannel(conversationId)) return false;
  try { assertCanMessage(conversationId, senderId); return true; } catch { return false; }
}

function getCallablePeer(conversationId, userId) {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation || conversation.kind !== 'direct' || conversation.is_channel || String(conversation.direct_key || '').startsWith('saved:')) return null;
  if (!isMember(conversationId, userId)) return null;
  const peer = db.prepare(`SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? AND cm.user_id != ? LIMIT 1`).get(conversationId, userId);
  if (!peer || peer.is_bot || isBlockedEitherWay(userId, peer.id)) return null;
  return peer;
}

function voiceRoomForConversation(conversationId) {
  for (const room of activeVoiceRooms.values()) if (room.conversationId === conversationId) return room;
  return null;
}

function createVoiceRoom(conversationId, startedBy, mode = 'audio') {
  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const room = { id, conversationId, startedBy, startedAt, mode: mode === 'video' ? 'video' : 'audio', participants: new Map() };
  activeVoiceRooms.set(id, room);
  db.prepare(`INSERT INTO voice_rooms (id, conversation_id, started_by, started_at, mode) VALUES (?, ?, ?, ?, ?)`)
    .run(id, conversationId, startedBy, startedAt, room.mode);
  return room;
}

function serializeVoiceParticipant(userId, joinedAt) {
  const user = getUserById(userId);
  return user ? { ...publicUser(user), joinedAt } : null;
}

function serializeLiveVoiceRoom(room) {
  const conversation = db.prepare('SELECT title FROM conversations WHERE id = ?').get(room.conversationId);
  return {
    id: room.id,
    conversationId: room.conversationId,
    title: conversation?.title || (room.mode === 'video' ? 'Видеокомната' : 'Голосовая комната'),
    mode: room.mode || 'audio',
    startedAt: room.startedAt,
    participants: [...room.participants.values()].map((item) => serializeVoiceParticipant(item.userId, item.joinedAt)).filter(Boolean)
  };
}

function serializeVoiceRoomHistory(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title || (row.mode === 'video' ? 'Видеокомната' : 'Голосовая комната'),
    mode: row.mode || 'audio',
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
    participantCount: Number(row.participant_count || 0)
  };
}

function leaveVoiceRoomForSession(sessionId, userId, reason = 'left') {
  const membership = voiceRoomByUser.get(userId);
  if (!membership || membership.sessionId !== sessionId) return;
  const room = activeVoiceRooms.get(membership.roomId);
  voiceRoomByUser.delete(userId);
  if (!room) return;
  const participant = room.participants.get(userId);
  if (!participant || participant.sessionId !== sessionId) return;
  room.participants.delete(userId);
  const leftAt = new Date().toISOString();
  db.prepare(`UPDATE voice_room_participants SET left_at = ? WHERE room_id = ? AND user_id = ? AND left_at IS NULL`).run(leftAt, room.id, userId);
  for (const other of room.participants.values()) {
    sendToSession(other.sessionId, { type: 'room:participant-left', roomId: room.id, userId, reason });
  }
  if (!room.participants.size) {
    db.prepare('UPDATE voice_rooms SET ended_at = ? WHERE id = ?').run(leftAt, room.id);
    activeVoiceRooms.delete(room.id);
  }
}

function activeCallForUser(userId) {
  for (const call of activeCalls.values()) {
    if ((call.caller_id === userId || call.callee_id === userId) && (call.status === 'ringing' || call.status === 'active')) return call;
  }
  return null;
}

function isCallParticipant(call, userId) {
  return call && (call.caller_id === userId || call.callee_id === userId);
}

function serializeCall(row, viewerId) {
  const peerId = row.caller_id === viewerId ? row.callee_id : row.caller_id;
  const peer = getUserById(peerId);
  return {
    id: row.id,
    conversationId: row.conversation_id || null,
    mode: row.mode === 'video' ? 'video' : 'audio',
    status: row.status,
    direction: row.caller_id === viewerId ? 'outgoing' : 'incoming',
    peer: peer ? publicUser(peer) : null,
    startedAt: row.started_at,
    answeredAt: row.answered_at || null,
    endedAt: row.ended_at || null,
    endedBy: row.ended_by || null
  };
}

function finishCall(callId, endedBy, status = 'ended', reason = 'ended') {
  const call = activeCalls.get(callId);
  if (!call) return;
  if (call.timeout) clearTimeout(call.timeout);
  const endedAt = new Date().toISOString();
  call.status = status;
  call.ended_at = endedAt;
  call.ended_by = endedBy;
  db.prepare('UPDATE calls SET status = ?, ended_at = ?, ended_by = ? WHERE id = ?').run(status, endedAt, String(endedBy || 'system'), call.id);
  const callerPayload = { type: 'call:ended', call: serializeCall(call, call.caller_id), reason };
  const calleePayload = { type: 'call:ended', call: serializeCall(call, call.callee_id), reason };
  if (call.callerSessionId) sendToSession(call.callerSessionId, callerPayload); else sendToUser(call.caller_id, callerPayload);
  if (call.calleeSessionId) sendToSession(call.calleeSessionId, calleePayload); else sendToUser(call.callee_id, calleePayload);
  activeCalls.delete(callId);
}

function endCallsForSession(sessionId, userId) {
  for (const call of [...activeCalls.values()]) {
    const attached = call.callerSessionId === sessionId || call.calleeSessionId === sessionId;
    if (!attached) continue;
    const status = call.status === 'ringing' ? (call.caller_id === userId ? 'cancelled' : 'missed') : 'ended';
    finishCall(call.id, userId, status, 'disconnected');
  }
}

function sendSocket(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function sendToSession(sessionId, payload) {
  if (!sessionId) return;
  const data = JSON.stringify(payload);
  for (const sockets of userSockets.values()) {
    for (const socket of sockets) if (socket.sessionId === sessionId && socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}


function serializeScheduledMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    body: row.body || '',
    replyToId: row.reply_to_message_id || null,
    attachmentId: row.attachment_id || null,
    sendAt: row.send_at,
    createdAt: row.created_at,
    status: row.status,
    sentMessageId: row.sent_message_id || null,
    error: row.error || null
  };
}

function processScheduledMessages() {
  const now = new Date().toISOString();
  const rows = db.prepare(`SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_at <= ? ORDER BY send_at ASC LIMIT 100`).all(now);
  for (const row of rows) {
    try {
      if (!isMember(row.conversation_id, row.user_id)) throw new Error('Нет доступа к чату.');
      assertCanMessage(row.conversation_id, row.user_id);
      const message = createMessage(row.conversation_id, row.user_id, {
        body: row.body,
        replyToId: row.reply_to_message_id,
        attachmentId: row.attachment_id
      });
      db.prepare(`UPDATE scheduled_messages SET status = 'sent', sent_message_id = ?, error = NULL WHERE id = ?`).run(message.id, row.id);
      emitMessageSideEffects(message, row.user_id);
      broadcastConversation(row.conversation_id, { type: 'message:new', message });
      sendToUser(row.user_id, { type: 'scheduled:sent', scheduledId: row.id, message });
    } catch (error) {
      db.prepare(`UPDATE scheduled_messages SET status = 'failed', error = ? WHERE id = ?`).run(String(error?.message || error).slice(0, 500), row.id);
      sendToUser(row.user_id, { type: 'scheduled:failed', scheduledId: row.id, message: String(error?.message || 'Не удалось отправить запланированное сообщение.') });
    }
  }
}

let fcmCached = null;
let fcmAccessToken = null;
let fcmAccessTokenExpiresAt = 0;
function loadFcmServiceAccount() {
  if (fcmCached !== null) return fcmCached || null;
  try {
    let raw = process.env.FCM_SERVICE_ACCOUNT_JSON || '';
    const file = process.env.FCM_SERVICE_ACCOUNT_FILE || '';
    if (!raw && file) raw = fs.readFileSync(path.resolve(file), 'utf8');
    if (!raw) { fcmCached = false; return null; }
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key || !(parsed.project_id || process.env.FCM_PROJECT_ID)) { fcmCached = false; return null; }
    fcmCached = parsed;
    return parsed;
  } catch (error) {
    console.warn('FCM config ignored:', error.message);
    fcmCached = false;
    return null;
  }
}

function b64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

async function getFcmAccessToken() {
  const account = loadFcmServiceAccount();
  if (!account) return null;
  if (fcmAccessToken && Date.now() < fcmAccessTokenExpiresAt - 60_000) return fcmAccessToken;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`FCM OAuth HTTP ${response.status}`);
  const body = await response.json();
  fcmAccessToken = body.access_token;
  fcmAccessTokenExpiresAt = Date.now() + Number(body.expires_in || 3600) * 1000;
  return fcmAccessToken;
}

async function sendFcmPush(device, notification, data = {}) {
  const account = loadFcmServiceAccount();
  if (!account || device.platform !== 'android') return false;
  const projectId = process.env.FCM_PROJECT_ID || account.project_id;
  const accessToken = await getFcmAccessToken();
  if (!projectId || !accessToken) return false;
  const stringData = Object.fromEntries(Object.entries(data || {}).map(([key, value]) => [key, String(value ?? '')]));
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: device.token, notification, data: stringData, android: { priority: 'high', notification: { channel_id: 'messages' } } } }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 404 || text.includes('UNREGISTERED')) db.prepare('DELETE FROM push_devices WHERE id = ?').run(device.id);
    throw new Error(`FCM send HTTP ${response.status}`);
  }
  return true;
}

function dispatchMessagePush(message, senderId) {
  const chat = db.prepare('SELECT title, kind, is_channel FROM conversations WHERE id = ?').get(message.conversationId);
  const sender = getUserById(senderId);
  const members = db.prepare(`SELECT cm.user_id, cm.muted_until FROM conversation_members cm WHERE cm.conversation_id = ? AND cm.user_id != ?`).all(message.conversationId, senderId);
  for (const member of members) {
    if (isBlockedEitherWay(member.user_id, senderId)) continue;
    if (member.muted_until && new Date(member.muted_until).getTime() > Date.now()) continue;
    if (userSockets.get(member.user_id)?.size) continue;
    const devices = db.prepare('SELECT * FROM push_devices WHERE user_id = ?').all(member.user_id);
    if (!devices.length) continue;
    const title = chat?.is_channel ? (chat.title || 'Канал') : (sender?.display_name || 'Новое сообщение');
    const body = String(message.body || (message.attachment ? `📎 ${message.attachment.fileName}` : 'Новое сообщение')).slice(0, 180);
    for (const device of devices) void sendFcmPush(device, { title, body }, { type: 'message', conversationId: message.conversationId, messageId: message.id }).catch((error) => console.warn('Push failed:', error.message));
  }
}

function sendToUserExceptSession(userId, sessionId, payload) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  const data = JSON.stringify(payload);
  for (const socket of sockets) if (socket.sessionId !== sessionId && socket.readyState === WebSocket.OPEN) socket.send(data);
}

function clientKey(req) {
  const forwarded = process.env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function assertRateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > limit) {
    const seconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    const error = httpError(429, `Слишком много действий. Повтори через ${seconds} сек.`);
    error.retryAfter = seconds;
    throw error;
  }
}

function isMember(conversationId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId));
}

function broadcastConversation(conversationId, payload, excludeUserId = null) {
  const syncable = new Set(['message:new', 'message:updated', 'message:deleted', 'message:reaction', 'conversation:updated', 'conversation:added', 'conversation:removed', 'channel:comments', 'scheduled:sent']);
  if (payload?.type && syncable.has(payload.type)) recordSyncForConversation(conversationId, payload.type, payload);
  const members = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId);
  for (const { user_id: userId } of members) {
    if (userId === excludeUserId) continue;
    const personal = payload.message ? { ...payload, message: getMessageById(payload.message.id, userId) } : payload.conversation ? { ...payload, conversation: getConversationForUser(conversationId, userId) } : payload;
    sendToUser(userId, personal);
  }
}

function broadcastPresence(userId, online) {
  const peers = db.prepare(`
    SELECT DISTINCT cm2.user_id
    FROM conversation_members cm1
    JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
    WHERE cm1.user_id = ? AND cm2.user_id != ?
  `).all(userId, userId);
  for (const peer of peers) {
    if (isBlockedEitherWay(userId, peer.user_id) || !canSeePresence(peer.user_id, userId)) continue;
    sendToUser(peer.user_id, { type: 'presence', userId, online });
  }
}

function sendToUser(userId, payload) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  const data = JSON.stringify(payload);
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(data);
}

function addUserSocket(userId, ws) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(ws);
}

function removeUserSocket(userId, ws) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  sockets.delete(ws);
  if (!sockets.size) userSockets.delete(userId);
}

function closeSessionSockets(sessionId) {
  db.prepare('DELETE FROM push_devices WHERE session_id = ?').run(sessionId);
  for (const sockets of userSockets.values()) {
    for (const socket of sockets) {
      if (socket.sessionId === sessionId) socket.close(4001, 'Session revoked');
    }
  }
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value ?? '')); } catch { return fallback; }
}

async function getWebAuthn() {
  if (!webauthnModulePromise) webauthnModulePromise = import('@simplewebauthn/server');
  return webauthnModulePromise;
}

function auditLog(userId, action, metadata = {}) {
  try {
    db.prepare('INSERT INTO audit_logs (id, user_id, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), userId || null, String(action).slice(0, 120), JSON.stringify(metadata || {}), new Date().toISOString());
  } catch (error) { console.warn('Audit log failed:', error.message); }
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function randomBase32(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}
function base32Encode(buffer) {
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}
function base32Decode(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const char of String(text || '').toUpperCase().replace(/=+$/g, '')) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secret, step) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
function verifyTotp(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  const step = Math.floor(Date.now() / 30_000);
  for (let drift = -1; drift <= 1; drift++) if (totpAt(secret, step + drift) === code) return true;
  return false;
}

function consumeSecondFactor(user, input) {
  const code = String(input || '').replace(/[\s-]/g, '').toLowerCase();
  if (/^[0-9a-f]{16}$/.test(code)) {
    const codes = parseJson(user.recovery_codes_json, []); const hash = hashToken(code);
    const index = codes.indexOf(hash); if (index < 0) return false;
    codes.splice(index, 1); db.prepare('UPDATE users SET recovery_codes_json = ? WHERE id = ?').run(JSON.stringify(codes), user.id); return true;
  }
  if (!/^\d{6}$/.test(code)) return false;
  const secret = decryptSecret(user.totp_secret_enc); if (!secret) return false;
  const step = Math.floor(Date.now() / 30_000);
  for (let drift = -1; drift <= 1; drift++) {
    const counter = step + drift;
    if (counter <= Number(user.last_totp_step ?? -1)) continue;
    const expected = totpAt(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
      return db.prepare('UPDATE users SET last_totp_step = ? WHERE id = ? AND last_totp_step < ?').run(counter, user.id, counter).changes === 1;
    }
  }
  return false;
}

function securityKey() {
  return crypto.createHash('sha256').update(SECURITY_MASTER_KEY).digest();
}
function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', securityKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}
function decryptSecret(value) {
  try {
    const [ivB64, tagB64, dataB64] = String(value || '').split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', securityKey(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function serializePrivacy(row) {
  return {
    lastSeen: row?.privacy_last_seen || 'everyone',
    calls: row?.privacy_calls || 'everyone',
    groups: row?.privacy_groups || 'everyone',
    readReceipts: row?.read_receipts !== 0
  };
}
function usersShareConversation(a, b) {
  return Boolean(db.prepare(`SELECT 1 FROM conversation_members x JOIN conversation_members y ON y.conversation_id = x.conversation_id WHERE x.user_id = ? AND y.user_id = ? LIMIT 1`).get(a, b));
}
function canAddUserToGroup(actorId, targetId) {
  if (actorId === targetId) return true;
  const target = getUserById(targetId);
  const rule = target?.privacy_groups || 'everyone';
  if (rule === 'everyone') return true;
  if (rule === 'nobody') return false;
  return usersShareConversation(actorId, targetId);
}

function canUserCallPeer(callerId, calleeId) {
  const user = getUserById(calleeId);
  if (!user) return false;
  const rule = user.privacy_calls || 'everyone';
  if (rule === 'nobody') return false;
  if (rule === 'contacts') return usersShareConversation(callerId, calleeId);
  return true;
}
function canSeePresence(viewerId, targetId) {
  const user = getUserById(targetId);
  if (!user) return false;
  const rule = user.privacy_last_seen || 'everyone';
  if (rule === 'nobody') return viewerId === targetId;
  if (rule === 'contacts') return viewerId === targetId || usersShareConversation(viewerId, targetId);
  return true;
}
function broadcastPrivacyChanged(userId) {
  const peers = db.prepare(`SELECT DISTINCT cm2.user_id FROM conversation_members cm1 JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id WHERE cm1.user_id = ? AND cm2.user_id != ?`).all(userId, userId);
  for (const peer of peers) sendToUser(peer.user_id, { type: 'privacy:updated', userId });
}

function recordSync(userId, type, conversationId, payload = {}) {
  try {
    db.prepare('INSERT INTO sync_events (user_id, type, conversation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, type, conversationId || null, JSON.stringify(payload || {}), new Date().toISOString());
    // Keep per-user sync logs bounded in the MVP.
    db.prepare(`DELETE FROM sync_events WHERE user_id = ? AND seq < COALESCE((SELECT seq FROM sync_events WHERE user_id = ? ORDER BY seq DESC LIMIT 1 OFFSET 4999), 0)`).run(userId, userId);
  } catch (error) { console.warn('Sync event failed:', error.message); }
}
function recordSyncForConversation(conversationId, type, payload = {}) {
  const members = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId);
  for (const row of members) recordSync(row.user_id, type, conversationId, payload);
}

function getChatFolders(userId) {
  const folders = db.prepare('SELECT * FROM chat_folders WHERE user_id = ? ORDER BY position, created_at').all(userId);
  return folders.map((row) => ({
    id: row.id,
    name: row.name,
    position: Number(row.position || 0),
    conversationIds: db.prepare('SELECT conversation_id FROM chat_folder_items WHERE folder_id = ?').all(row.id).map((item) => item.conversation_id)
  }));
}
function serializeUploadSession(row, chunks = []) {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: Number(row.size),
    chunkSize: Number(row.chunk_size),
    totalChunks: Number(row.total_chunks),
    receivedChunks: chunks,
    status: row.status,
    mediaId: row.media_id || null,
    expiresAt: row.expires_at
  };
}
function exportUserData(userId) {
  const user = getUserById(userId);
  const conversations = getConversations(userId);
  const messages = db.prepare(`SELECT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ? ORDER BY m.created_at`).all(userId);
  const drafts = db.prepare('SELECT * FROM user_drafts WHERE user_id = ? ORDER BY updated_at').all(userId);
  const folders = getChatFolders(userId);
  const scheduled = db.prepare('SELECT * FROM scheduled_messages WHERE user_id = ? ORDER BY created_at').all(userId).map(serializeScheduledMessage);
  return {
    format: 'messenger-user-export-v1',
    exportedAt: new Date().toISOString(),
    user: publicUser(user),
    privacy: serializePrivacy(user),
    conversations,
    messages,
    drafts,
    folders,
    scheduled
  };
}

function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
  const ip = clientKey(req);
  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, hashToken(token), now.toISOString(), expires.toISOString(), now.toISOString(), userAgent, ip);
  return { token, id };
}

function touchSession(sessionId) {
  if (!sessionId) return;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
}

function authenticate(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) return null;
  const token = value.slice(7);
  const session = getSessionByToken(token);
  return session ? { user: session.user, token, sessionId: session.sessionId } : null;
}

function getSessionByToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.id AS session_id, u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(hashToken(token), new Date().toISOString());
  if (!row) return null;
  return { sessionId: row.session_id, user: row };
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio || '',
    avatarMediaId: row.avatar_media_id || null,
    createdAt: row.created_at,
    isBot: Boolean(row.is_bot)
  };
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

function normalizeChannelUsername(value) {
  const username = String(value || '').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,24}$/.test(username) ? username : '';
}

function validateRegistration(username, displayName, password) {
  if (!/^[a-z0-9_]{3,24}$/.test(username)) throw httpError(400, 'Username: 3–24 символа, только a-z, 0-9 и _.');
  if (displayName.length < 1 || displayName.length > 48) throw httpError(400, 'Имя должно быть от 1 до 48 символов.');
  if (password.length < 8 || password.length > 128) throw httpError(400, 'Пароль должен быть не короче 8 символов.');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, encoded) {
  try {
    const [kind, saltB64, keyB64] = String(encoded).split('$');
    if (kind !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function scrypt(password, salt, length = 64) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, length, { N: 16384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key));
  });
}

function safeFileName(value) {
  const cleaned = String(value || 'file').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim();
  return (cleaned.replace(/[\u202a-\u202e\u2066-\u2069]/g, '') || 'file').slice(0, 180);
}

function setCors(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Access-Control-Allow-Origin', getAllowedOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-File-Name');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : DEFAULT_ALLOWED_ORIGIN;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(httpError(413, 'Слишком большой запрос.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required'); resolve(value); } catch { reject(httpError(400, 'Нужен JSON объект.')); }
    });
    req.on('error', reject);
  });
}

function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, `Максимальный размер файла — ${Math.round(limit / 1024 / 1024)} МБ.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendEmpty(res, status) {
  res.writeHead(status);
  res.end();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
