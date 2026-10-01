# Marocto Messenger — изменения

## 1.0.0 — 2026-10-01

- Новый дизайн Midnight/Graphite/Light, навигация для desktop и phone, SVG icons, focus-aware dialogs и разделённые настройки.
- Выделены типы, форматирование, avatar, settings, calls, native integration; настройки загружаются лениво.
- Исправлены потеря черновиков, гонка исходящих, загрузка истории, временные связи WebSocket handlers и синхронизация событий.
- Детерминированная pagination `(created_at,id)`, совместимые миграции v0.14, session-aware push и отзыв WS/media tickets.
- Безопасная обработка MIME, Range streaming, resumable uploads с повторным completion, поиск вложений и просмотр изображений.
- Добавлены выбор сообщений, множественная отправка файлов и визуальная группировка медиаальбомов.
- Усилены CORS, authorization, rate limits, WebAuthn verification, TOTP replay protection и recovery codes.
- Webhook SSRF protection; Mini Apps изолированы от origin аккаунта; production native builds требуют HTTPS/WSS.
- Android share reader, deep links, lifecycle/back navigation; Tauri deep links/single instance и CSP; одно окно launcher Windows.
- Backup/restore checksums, integrity/FK checks, live-server guard и сохранение предыдущих данных без stale WAL.
- Добавлены integration/security/browser tests; результаты и ограничения зафиксированы в docs/RELEASE_REPORT.md.

# Changelog

## 0.14.0 — Mega Update

This release combines the planned v0.11, v0.12, v0.13 and v0.14 work into one upgrade.

### Sync / Offline / Files
- IndexedDB conversation/message cache with cache-first chat opening.
- Incremental multi-device sync cursor via `/sync`.
- Synced per-chat drafts across sessions/devices.
- Offline outbox remains idempotent through `clientRequestId`.
- Resumable chunk uploads with status/retry and progress UI, up to 512 MB.
- Shared-media browser now includes media, files and extracted links.
- Android native Share Target for text/links/files metadata.

### Calls Pro
- Group audio rooms (8 participants in the current mesh implementation).
- Group video rooms (6 participants in the current mesh implementation).
- Live microphone/camera switching.
- Group screen sharing.
- Personal call screen sharing and ICE recovery retained.
- Live WebRTC diagnostics: RTT, jitter, packet loss and inbound bitrate.
- TURN configuration and `/rtc/config` endpoint.
- SFU-ready server configuration flag for a future SFU deployment.

### Security / Production
- TOTP 2FA with encrypted-at-rest TOTP secret.
- Passkeys/WebAuthn registration and login.
- Stronger session controls and security audit events.
- Privacy controls for last-seen, calls, group additions and read receipts.
- Privacy rules enforced by calling/group membership flows.
- Security HTTP headers and production warnings.
- User JSON export.
- Backup/restore scripts.
- Docker production server configuration and production environment template.

### UX completeness
- Archive and pinned chat state.
- Custom chat folders.
- Global search across chats/messages/users.
- Media / files / links browser.
- Three UI themes: Midnight, Graphite and Light.
- Synced drafts.
- Scheduled-message editing and cancellation.
- Privacy/security controls integrated into Settings.
- Fixed duplicate bot-creation request inherited from an older settings implementation.

### Final hardening
- Docker healthcheck now uses Node 22 built-in `fetch` and does not depend on `wget` being installed.
- Expired in-memory rate-limit buckets are periodically purged to prevent unbounded key accumulation.

### Database
- Automatic migration remains compatible with earlier MVP databases.
- Added sync events, drafts, folders, resumable uploads, passkeys and audit logs.
