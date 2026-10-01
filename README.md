# Marocto Messenger 1.0.0

Самостоятельный мессенджер: Next.js/React, Node.js/WebSocket, SQLite, Windows/Tauri 2 и Android/Capacitor 8. Это полный исходный релиз с lockfile и тестами. База v0.14 обновляется на месте; сброс данных не требуется.

## Быстрый запуск Web

Требуется Node.js 22+. Распакуйте проект, например в `D:\Marocto\messenger-v1.0.0`, и откройте PowerShell в этой папке:

```powershell
powershell -ExecutionPolicy Bypass -File .\RUN.ps1
```

Или запустите `RUN_WINDOWS.cmd`. Одна консоль показывает логи `[API]` и `[WEB]`; Ctrl+C завершает оба процесса. При первом запуске устанавливаются зависимости из lockfile, создаются только отсутствующие локальные env-файлы. Откройте **http://localhost:3000**. Пользователей и тестовых баз в архиве нет: первый аккаунт создаётся через интерфейс.

Кэши npm, Gradle, временные файлы и выход Cargo размещаются в `.runtime` рядом с проектом. Расположение установленных Node.js, Rust и Android SDK выбирается при их установке. Скрипты не перемещают установленные SDK и не переназначают домашнюю папку пользователя. Для Android установите `ANDROID_HOME` на фактический SDK; если C: ограничен, выберите D:/E: при установке SDK и Rust.

## Команды

Все команды выполняются из корня проекта. `npm ci` устанавливает точные версии из `package-lock.json`.

| Сценарий | Команда |
|---|---|
| Web, сервер и клиент в одном окне | `npm run dev` |
| Только API | `npm run dev:server` |
| Только Web | `npm run dev:web -- --hostname 127.0.0.1` |
| Статический Web | `npm run build:web` → `apps/web/out` |
| Windows development | `powershell -ExecutionPolicy Bypass -File .\RUN.ps1 desktop` |
| Windows production | задайте HTTPS/WSS ниже, затем `powershell -ExecutionPolicy Bypass -File .\RUN.ps1 build:desktop` |
| Подготовка Android | `powershell -ExecutionPolicy Bypass -File .\RUN.ps1 prepare:android` |
| Android Studio | `powershell -ExecutionPolicy Bypass -File .\RUN.ps1 open:android` |
| Android debug APK | `powershell -ExecutionPolicy Bypass -File .\RUN.ps1 build:android` |
| Android release APK | задайте HTTPS/WSS ниже, затем `powershell -ExecutionPolicy Bypass -File .\RUN.ps1 release:android` |
| Backend production | настройте `server/.env`, затем `npm run start:server` |
| Серверные тесты | `npm test` |
| Браузерные тесты | см. ниже |
| ESLint / TypeScript | `npm run lint` / `npm run typecheck` |

### Windows production

Установите Rust, Microsoft C++ Build Tools и WebView2. Backend запускается отдельно: инсталлятор содержит клиент, а не сервер.

```powershell
$env:NEXT_PUBLIC_API_URL = 'https://api.your-domain'
$env:NEXT_PUBLIC_WS_URL = 'wss://api.your-domain/ws'
powershell -ExecutionPolicy Bypass -File .\RUN.ps1 build:desktop
```

При использовании launcher результат находится в `.runtime\cargo-target\release\bundle`. При обычном `npm run build:desktop` — в `apps\desktop\src-tauri\target\release\bundle`, если `CARGO_TARGET_DIR` не задан. Production-предпроверка отклоняет localhost и HTTP/WS. Deep links: `marocto-messenger://invite/<token>` и `marocto-messenger://chat/<conversationId>`.

### Android

Требуются Android Studio/SDK и совместимый JDK (Capacitor 8: JDK 21). Debug по умолчанию обращается к `http://10.0.2.2:4000` в эмуляторе. Для физического телефона задайте адрес API, доступный с телефона; localhost телефона не является ПК.

```powershell
$env:ANDROID_API_URL = 'https://api.your-domain'
$env:ANDROID_WS_URL = 'wss://api.your-domain/ws'
powershell -ExecutionPolicy Bypass -File .\RUN.ps1 release:android
```

Debug APK: `apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk`. Release: `apps\mobile\android\app\build\outputs\apk\release`; без собственного keystore APK остаётся неподписанным. Перед публикацией настройте signing в Android Studio. Firebase-файл `google-services.json` добавляется в `apps/mobile/android/app/`; серверный service account храните отдельно. Генератор проекта включает deep links, Share Target, разрешения и `adjustResize`; production отключает cleartext и mixed content, даже после предыдущего debug build.

### Браузерные тесты

Тесты используют production export и отдельную временную БД. Порты 3000 и 14382 должны быть свободны.

```powershell
npm ci
npx playwright install chromium
$env:NEXT_PUBLIC_API_URL = 'http://localhost:14382'
$env:NEXT_PUBLIC_WS_URL = 'ws://localhost:14382/ws'
npm run build:web
npm run test:ui
```

В этой среде полная передача WebRTC не подтвердилась; для явного пропуска только этого теста задайте `SKIP_WEBRTC_MEDIA=true`. Не применяйте этот флаг при production-проверке сети.

После тестов пересоберите Web с адресами реального сервера. Для существующего Chromium можно задать `PLAYWRIGHT_CHROMIUM_PATH`. Тестовые аккаунты и БД уничтожаются после завершения. Трассы тестов могут содержать тестовые токены; не публикуйте их.

## Обновление v0.14

1. Остановите старый сервер и сделайте резервную копию.
2. Сохраните исходные `server/data` и env-файлы. Установите новую версию в отдельную папку.
3. Укажите `DATA_DIR` на прежнюю папку данных либо перенесите **всю** остановленную папку данных в новый `server/data`.
4. Сохраните прежний `SECURITY_MASTER_KEY`: его смена без процедуры переноса ломает расшифровку TOTP-секретов.
5. Выполните `npm ci`, запустите сервер. Миграции добавляют столбцы и индексы; существующие записи сохраняются.
6. Проверьте вход, историю и `/health`. Перед откатом используйте резервную копию старой версии.

## Резервные копии

`npm run backup` создаёт согласованный SQLite snapshot и копирует медиа. `DATA_DIR` и `BACKUP_DIR` поддерживаются. Секреты конфигурации в резервную копию не включаются; храните master key отдельно.

```powershell
npm run backup
# Перед восстановлением остановите сервер.
$env:CONFIRM_RESTORE = 'YES'
node scripts/restore.mjs 'D:\MaroctoBackups\2026-10-01T...'
```

Восстановление проверяет SQLite, foreign keys, наличие медиа и SHA-256 manifest. Прежняя папка данных сохраняется как `.before-restore-*`; WAL не переносится в восстановленную базу.

Дополнительные сведения: [production](PRODUCTION.md), [результаты проверки](docs/RELEASE_REPORT.md), [изменения](CHANGELOG.md), [дизайн](docs/DESIGN.md).
