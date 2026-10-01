# Marocto Messenger 1.0.0 — отчёт релиза

Дата проверки: 1 октября 2026. Исходная версия: полный архив v0.14. Изменён существующий проект; сервер, SQLite и рабочие API сохранены. В архиве — исходники, lockfile, тесты, launcher и документация. Windows installer и APK в него не входят.

## Что изменилось

- Общая система оформления Midnight/Graphite/Light; самостоятельная M-монограмма и platform icons, трёхколоночный desktop, отдельная phone-навигация, keyboard/touch actions, focus trap и reduced motion.
- Переписка: группировка, даты и unread separator, reply/edit/reaction/forward, выбор сообщений, emoji и autoresize, понятные состояния очереди/ошибок, изображения в viewer и потоковое воспроизведение медиа.
- Настройки разделены на subpages. Поиск разделяет людей, каналы, сообщения, вложения и ссылки, подсвечивает совпадения; результаты людей открывают переписку.
- Множественная отправка файлов и двухколоночные медиаальбомы сохраняют отдельные идентификаторы и действия каждого сообщения. Альбом не является единой атомарной серверной транзакцией.
- Вынесены calls, settings, avatar, UI primitives, types, formatting, configuration и native lifecycle. Нет необоснованной полной переписи проекта.
- Windows launcher показывает API и клиент в одной консоли, направляет кэши и temporary/build output в папку проекта. Android project создаётся и синхронизируется скриптом; Share Target читает реальные файлы из полученных content URI.

## Основные исправленные ошибки

1. Pagination с одинаковым timestamp могла пропускать или повторять сообщения. Используются `(created_at,id)` и составной cursor; старый формат поддерживается.
2. Повторное выполнение upload completion могло создавать второй файл; сборка больших файлов блокировала event loop. Теперь completion идемпотентен, части собираются асинхронно, ошибки очищают промежуточный файл.
3. Исходящие могли терять новые записи, добавленные во время flush, или оставлять их до нового reconnect. Очередь перечитывается перед изменениями, имеет повторные попытки и terminal failure; request id не допускает дублей и переиспользования в другом чате.
4. Облачный черновик и sync replay могли затереть свежий локальный текст. Версии/dirty metadata защищают локальные изменения и сохраняют их для повторной синхронизации.
5. Sync мог обрезать уже загруженную историю до последних 50 строк. Изменения сливаются по message id; старые правки остаются доступны, payload сериализуется для текущего пользователя.
6. Изменение call-device state могло пересоздавать WebSocket handlers. Используются стабильные обработчики и refs; startup-запросы выполняются параллельно, старые ответы списка чатов отсеиваются.
7. UI показывал активный звонок сразу после SDP, до установления ICE. Статус меняется по peer connection; неудачное соединение освобождает устройства и сообщает о сети/TURN. Групповой grid не дублирует собственную плитку.
8. Restore мог оставлять WAL от предыдущей БД и повреждать восстановленные данные. Новый restore проверяет snapshot/media/checksums, блокирует live server и сохраняет прежнюю папку целиком.
9. Android debug cleartext мог сохраняться в release manifest; Share Target передавал URI, но не содержимое файла. Добавлены reset конфигурации, reader, lifecycle/back handling и session-aware push callbacks.
10. Смена профиля/сессии и сетевые ошибки больше не приводят к бесконечным initial fetch loops или безусловному выходу из аккаунта при неверном коде 2FA.
11. Tauri использовал production CSP и в development, блокируя локальные API/media/WebSocket. Отдельная devCsp разрешает localhost; production остаётся HTTPS/WSS.

## Безопасность

- Проверяется membership при edits, deletion, drafts, media/gallery и чувствительных действиях; изгнанный автор не продолжает изменять сообщения в группе.
- CORS отвергает посторонние origin, PUT preflight работает. IP/account/WS/auth/upload ограничения включены; forwarding IP учитывается только с явным `TRUST_PROXY`.
- WS revalidates session при пакетах и heartbeat, ограничивает payload, закрывается после отзыва. Media ticket ограничен одним файлом, временем и действующей сессией.
- MIME определяется по содержимому; HTML/SVG и неподтверждённые типы скачиваются как файлы. Имена нормализуются; private media требует доступа. Поддерживается HTTP Range.
- Webhook HTTPS, DNS validation и закрепление разрешённого IP защищают от SSRF/redirect/DNS rebinding на private networks.
- Mini App sandbox исключает same-origin и доступ к камере/микрофону/аккаунту; браузер проверил невозможность чтения parent localStorage.
- WebAuthn требует user verification; malformed responses возвращают controlled 400/401. TOTP блокирует replay, recovery codes одноразовые и хешированные.
- Push registration связан с session; revoke/logout удаляет её push registration. Production отклоняет слабый master key; native production build требует HTTPS/WSS.
- Сквозного шифрования сообщений нет. Это свойство не заявляется.

## Результаты

| Проверка | Результат |
|---|---|
| JSON/package metadata, backend/scripts syntax | Прошла |
| TypeScript | Прошла |
| ESLint | Прошла, без ошибок и предупреждений |
| Next.js production export | Прошёл |
| Node integration/security tests | **16 прошли**, 0 ошибок |
| Chromium browser tests | **9 прошли**, 1 явно пропущен |
| v0.14 schema → v1.0, повторные миграции | Прошли; данные и foreign keys сохранены |
| Auth/messages/groups/channels/comments/replies/edit/delete/reactions/mentions/forward | Проверены API; основные message flows также браузером |
| Upload resume/completion retry/MIME/access/Range | Проверены API; upload/viewer/gallery/album также браузером |
| Offline queue, deduplication, reconnect, drafts, sync/history | Прошли |
| Search, invites, scheduled delivery, activity, block/report, Bot API/rotate token | Прошли |
| TOTP/recovery codes, virtual WebAuthn registration/login, revoke session | Прошли |
| Audio/video/group signaling, mic control и очистка tracks | Прошли |
| Полная передача WebRTC audio/video | **Не подтверждена в среде**, см. ниже |
| Android prepare и Capacitor sync | Прошли; manifest/native source copy и debug→release cleartext reset проверены |
| Android APK | **Не собран**: Gradle distribution download недоступен; SDK не настроен |
| Tauri/Windows installer | **Не собран**: Cargo отсутствует |
| Native push/signing/TURN between real networks/Docker deployment | Не выполнялись: нужны внешние SDK/credentials/infrastructure |
| npm audit | **0 известных уязвимостей** на дату проверки |

Backend tests создают БД из точной legacy schema v0.14, затем запускают настоящий сервер. Browser tests используют production export и отдельную временную БД, виртуальный WebAuthn authenticator, два клиента с synthetic camera/microphone и отдельный mobile touch context. Registration proxy headers в UI fixture задаются явно для независимых тестовых IP; limiter в приложении не отключается.

Попытка полной передачи WebRTC не прошла: Chromium не получил ICE candidates, оставался в `new/gathering`, reported `STUN host lookup received error`. Это не считается успешным медиатестом. В последнем suite он пропущен только с явным `SKIP_WEBRTC_MEDIA=true`; на обычной машине запускается по умолчанию и должен пройти перед production. OS screen capture, реальные microphones/cameras, смена сетей и physical-device audio route не проверены. UI управления и signaling проверены отдельно.

ESLint сохраняет hook correctness, purity, TypeScript и accessibility checks. Правило `react-hooks/set-state-in-effect` отключено с пояснением для внешней cache hydration и asynchronous loaders; React Compiler не включён. Это исключение не выдаётся за доказательство performance.

## Визуальная проверка

Просмотрены browser screenshots: auth, desktop conversation, три темы, settings, phone list/chat с touch, connecting call и двухучастниковая video room. Light tokens/foreground/background проверены после завершения перехода темы. Снимки с синтетическим camera test pattern не подтверждают передачу удалённого видео.

Скриншоты находятся в `docs/screenshots`, логи проверок — в `docs/validation`. В них только вымышленные тестовые аккаунты. Трассы с токенами, тестовые БД, runtime caches, `node_modules`, `.next`, Android generated build tree и build artifacts исключены из релиза.

## Ограничения и инфраструктура

Нужны ваш domain/TLS, production TURN, Firebase credentials, Rust/MSVC/WebView2 и Android SDK/JDK, signing certificates и проверка на физических устройствах. SFU transport, горизонтальное масштабирование, E2EE, email/SMS recovery, native background incoming calls, автоматические storage quotas/retention/malware scan и moderator console не реализованы. Веб-уведомления работают при запущенном клиенте; Web Push service worker/background web delivery отсутствуют. Reports сохраняются, но внешняя служба модерации не включена.

API/database release совместим с v0.14. Миграционный тест подтверждает legacy schema и данные fixture; перед обновлением ваших реальных данных всё равно используется резервная копия и неизменный master key. Точные команды запуска, Windows/Android builds и production backend перечислены в [README](../README.md) и [PRODUCTION](../PRODUCTION.md).
