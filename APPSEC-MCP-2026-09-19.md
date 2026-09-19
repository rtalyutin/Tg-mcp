# Ограниченная AppSec-проверка MCP-интеграции — 19.09.2026

**PASS только для локального integration harness 0.5.0.** Проверка не является
аудитом будущего Timeweb-сервиса и не закрывает OAuth, TLS, reverse proxy,
права Telegram-бота или фоновые вызовы ChatGPT.

## Объём и границы доверия

Активы: токен доступа к MCP, токен бота, фиксированный ID канала, возможность
создать внешний пост и RAM-состояние попыток. Проверенный поток:
синтетический MCP-клиент → loopback HTTP → официальный MCP SDK → один
`Publisher` → один `TelegramSender` → локальный mock Telegram. Реальные
внешние адреса и учётные данные не использовались.

## Подтверждённые свойства

- listener привязан к `127.0.0.1`; точный Host обязателен, Origin запрещён;
- все MCP-запросы требуют Bearer, лишние поля отклоняются строгими схемами;
- канал и адрес mock Telegram задаются сервером, клиент не может передать
  `chat_id`, API root, `force` или команду повторной отправки;
- write-harness принимает только `http://127.0.0.1:<port>`; официальный и
  внешние hosts, HTTPS-loopback, credentials, query и hash отклоняются;
- `src/main.ts` запускает только read-only профиль и блокирует production,
  внешний HOST и `PUBLISH_ENABLED`;
- `publish_story` честно помечен как `readOnlyHint=false`,
  `idempotentHint=false`, `openWorldHint=true`; чтения — read-only;
- MCP-ответы не содержат access token, bot token или текст прошлых попыток;
- после UNKNOWN/PARTIAL и при replay число mock-запросов не растёт.

Динамическое evidence: 61/61 тестов PASS, включая 4 независимые held-out
группы; TypeScript PASS. `npm audit --omit=dev` для текущего lockfile сообщил
0 известных уязвимостей. Поиск распространённых форматов секретов вне
`node_modules` не нашёл совпадений. Новые зависимости не добавлены.

## Остаток

Локальный Bearer — тестовая фикстура, не OAuth. Значение `telegram_ready` в
harness задаётся тестом, а не проверкой `getMe/getChat/getChatMember`. Будущий
production-профиль должен реализовать аутентификацию, реальную readiness,
rate/body limits за reverse proxy и редактирование журналов исходящих URL:
Telegram Bot API по своему протоколу включает токен в URL. `telegramApiRoot`
нельзя превращать во внешнюю переменную production-профиля. Эти ограничения
блокируют выпуск, но не локальный gate этого шага.
