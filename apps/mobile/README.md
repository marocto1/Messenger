# Marocto Android 1.0.0

Оболочка Capacitor 8 для общего клиента. Точные команды, env и требования SDK/JDK: [README в корне](../../README.md#android).

Поддерживаются `marocto-messenger://invite/<token>`, `marocto-messenger://chat/<conversationId>`, текст и файлы через Share Target. Файлы читаются native plugin только из content URI, полученных от share intent, копируются в cache с лимитом 512 МБ; несколько файлов передаются последовательно после выбора беседы. Generated Android project создаётся prepare-скриптом, Java-исходники — в `native/`.

Firebase credentials, signing keystore и Android SDK в source archive не включаются. Полные APK/настоящий FCM/фоновые calls на физическом устройстве здесь не проверены. См. [отчёт](../../docs/RELEASE_REPORT.md).
