# Marocto Messenger 1.0 — production

## Размещение

Клиент — статический export `apps/web/out`. API — отдельный Node.js процесс и SQLite в постоянной папке `DATA_DIR`. Перед публикацией задайте адреса `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` **на этапе сборки**: последующая смена server env не переписывает клиент.

```bash
npm ci
NEXT_PUBLIC_API_URL=https://api.your-domain NEXT_PUBLIC_WS_URL=wss://api.your-domain/ws npm run build:web
cp server/.env.production.example server/.env
# Заполните реальные значения и секреты в server/.env.
npm run start:server
```

Для Linux используйте systemd/container supervisor, чтобы процесс перезапускался после сбоя. Одна папка данных обслуживается одним сервером. Горизонтальное масштабирование с общей SQLite, распределённым signaling и push не реализовано.

Пример reverse proxy Caddy:

```caddyfile
api.your-domain {
  reverse_proxy 127.0.0.1:4000
}
messenger.your-domain {
  root * /srv/marocto/web/out
  encode zstd gzip
  file_server
}
```

Caddy обеспечивает TLS и проксирование WebSocket. Для nginx нужны Upgrade/Connection и подходящие таймауты WS. Не публикуйте API через обычный HTTP. `ALLOWED_ORIGIN` должен содержать только реальные origin клиентов. `TRUST_PROXY=true` задавайте только за своим прокси, который переписывает `X-Forwarded-For`.

## Секреты и аутентификация

Создайте уникальный master key:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Сохраните его как `SECURITY_MASTER_KEY` вне публичных файлов. Production отклоняет короткие и шаблонные ключи. Ключ должен сохраняться между перезапусками и обновлениями: им шифруются TOTP-секреты. Пароли используют scrypt; session tokens и одноразовые recovery codes хранятся хешированными. Сессии передаются как Bearer headers; WebSocket получает токен при handshake. Исключите query strings WS и media tickets из proxy/access logs.

`WEBAUTHN_RP_ID` — имя домена без схемы/порта, `WEBAUTHN_ORIGINS` — точные HTTPS origin. Passkeys в нативном WebView зависят от поддержки платформы и RP; браузерный HTTPS-клиент проверен виртуальным authenticator. Нельзя обещать поддержку ключа произвольного web-домена в локальном WebView. У пользователей с 2FA должны быть сохранённые recovery codes. Сброс через email/SMS и восстановление при утрате всех факторов не реализованы.

Сервер не реализует сквозное шифрование переписки. TLS защищает транспорт; оператор сервера имеет доступ к данным и медиа. Не описывайте продукт как E2EE.

## WebRTC

Приватные аудио/видеозвонки и групповые комнаты используют mesh WebRTC, signaling — WebSocket. Лимиты: 6 участников видео, 8 аудио. Настройте `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`; клиент получает их из `/rtc/config`. Для production нужна проверка звонков между разными сетями, мобильными операторами и NAT.

SFU транспорт отсутствует. `SFU_URL` зарезервирован, но не включает SFU: API прямо сообщает `enabled:false`. Одной установки URL недостаточно для масштабирования групповых звонков. Имеющиеся TURN credentials статические; для публичного сервиса следует внедрить выдачу краткоживущих credentials вашим TURN-провайдером.

## Android push

FCM HTTP v1: укажите `FCM_PROJECT_ID` и защищённый `FCM_SERVICE_ACCOUNT_FILE`. Файл не включается в архив, Docker image или клиентскую сборку. Android `google-services.json` относится к вашему package `com.marocto.messenger`. Регистрация push происходит после согласия пользователя; токен привязан к сессии и удаляется при её отзыве. Доставка фоновых звонков с полноэкранным native incoming-call UI/foreground service не реализована; приложение не заменяет системную телефонию.

## Bot API и Mini Apps

Токены показываются один раз; храните их как секреты. Production webhook/Mini App URLs требуют публичного HTTPS. Webhooks проверяют DNS, запрещают private/loopback/link-local адреса, не следуют redirects и ограничивают ожидание. Для демонстрационного сервера на localhost используйте `ALLOW_LOCAL_WEBHOOKS=true` только в development и `node examples/BOT_DEMO.mjs`.

Mini App имеет sandbox без `allow-same-origin`, без доступа к аккаунту и устройствам. Приложения, требующие third-party cookies, обычного origin storage или privileged bridge, нуждаются в отдельном контракте интеграции. Некоторые сайты запрещают iframe через CSP/X-Frame-Options; предусмотрены повтор и открытие отдельно, но браузер не всегда раскрывает причину блокировки родительскому документу.

## Данные и эксплуатация

Резервная копия: `npm run backup`. Для переноса остановленного сервера используйте всю папку данных. Перед restore остановите процесс; `server.lock` блокирует восстановление поверх работающей версии. Прежняя папка сохраняется, manifest и SQLite проверяются до замены. Master key и env-файлы копируются отдельно в защищённое хранилище.

Медиа хранится без автоматического срока удаления и без шифрования на диске. Настройте шифрование тома, права и мониторинг свободного места. Максимум resumable файла 512 МБ; 8 незавершённых transfers на пользователя; части просроченных uploads очищаются. Общая пользовательская квота, антивирус и сервис модерации не реализованы. Reports сохраняются в БД; отдельной консоли модераторов нет.

Рекомендуемая проверка перед публикацией: свой домен/TLS, настоящие passkeys и TOTP recovery, TURN из разных сетей, FCM на физическом телефоне, signed Windows installer и Android APK, восстановление резервной копии на отдельной машине. В [отчёте](docs/RELEASE_REPORT.md) результаты окружения отделены от этих внешних проверок.

## Docker

```bash
docker compose -f docker-compose.production.yml up --build -d
```

Build context — корень, используется lockfile и только workspace server. Контейнер работает без root. Убедитесь, что папка `server/data` доступна UID 1000, и измените production `DATA_DIR` на `/app/server/data` для контейнера. Внешний порт привязан к `127.0.0.1:4000`. Docker-сборка в предоставленной среде не выполнялась.
