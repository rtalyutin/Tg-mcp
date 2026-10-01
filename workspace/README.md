# Совместная работа — backend 1.0.5 / UI 1.0.2

Самостоятельный backend для панели проектов в ChatGPT и десктопном клиенте. Хранит проекты и подпроекты, задачи, материалы и их версии, «Внимание», решения, контекст, историю запусков, пакеты навыков и каталог подключений. HTTP и MCP используют одну предметную модель и одни схемы операций.

Основание: [согласованное ТЗ 1.0](https://chatgpt.com/space/page_f5ad8674fd2c8191bf162359781e9b60). Backend и первый экран plugin pane подключены к Tg-mcp. Установка навыков в реальные клиенты и перенос работающих расписаний относятся к следующему интеграционному этапу.

## Обновление экрана проектов

В Tg-mcp экран работает через существующий owner API, в плагине — через `App.callServerTool` с прежней авторизацией MCP. Открытая страница проверяет данные каждые 15 секунд после завершения предыдущего чтения. Изменения проектов, задач, «Внимания» и запусков, записанные в `roman_workspace` через чат или worker, появляются автоматически. Скрытая страница и отсутствие сети приостанавливают опрос; возвращение на экран или восстановление сети запускает чтение сразу. Это не подключает чужие чаты или расписания ChatGPT и не запускает worker.

Время последнего успешного ответа сервера отображается вверху с секундами, в московском времени. При первом открытии видны движущаяся полоса и скелетоны; при `prefers-reduced-motion` анимация отключена. Фоновая загрузка сохраняет прежние строки, поиск, active/archive, фильтр «Внимания», загруженные страницы событий и открытые окна. Карточка и результаты поиска также перечитываются. Сбой сохраняет последние данные и их время, показывает ошибку и повторяет чтение через 30/60/120 секунд. Кнопка обновления позволяет повторить сразу. После создания проекта выполняется свежее чтение, даже если более старый запрос ещё не завершился.

В плагине автоматический опрос начинается после получения initial tool-result и не пересекается с медленным host opener. Неудачный initial result запускает повтор через 30 секунд; при отсутствии уведомления за 20 секунд показывается ошибка с ручным повтором. Интерфейс сериализует инициированные им чтения; host-owned opener после ручного повтора отменить нельзя, поэтому поздний initial result/error не может заменить уже полученный свежий snapshot. Сбой тихого перечитывания поиска или карточки оставляет их прежнее содержимое рядом с сообщением об ошибке.

## Запуск

Требуются Node.js 24, npm и отдельная PostgreSQL 16+ база. Локальные тесты используют настоящую PostgreSQL 18.4 из закреплённого dev-пакета. Не нужны Docker, системная установка PostgreSQL или платный API для тестов.

```sh
npm ci
cp .env.example .env
```

В `.env` задайте свою базу, owner UUID и **три разных случайных секрета**. Пример секрета: `openssl rand -hex 32`. Примерные credentials в `.env.example` предназначены только для настройки. Production использует отдельные JWT audiences, разрешённый UI client и HTTPS.

```sh
npm run migrate
npm run dev
```

Сервер по умолчанию слушает `127.0.0.1:3000`. `/health` — жив процесс; `/ready` — доступна база. Приложение не выполняет миграции при старте. Migration runner сериализует применение и проверяет SHA-256 уже применённых файлов.

Для сборки:

```sh
npm run build
npm start
```

В production переменные передаются средой/secret manager. Dockerfile собирает образ с непривилегированным пользователем; образ и реальный deployment в этой поставке не запускались. Команды внутри образа: `node dist/src/migrate.js`, `node dist/src/main.js`, `node dist/src/worker-main.js`. Перед внешним HTTPS endpoint нужен TLS reverse proxy. Используйте одну выделенную БД; авторизация и SQL credentials не принадлежат клиенту.

## API и клиентский сценарий

`POST /api/operations/<operation>` принимает JSON. Читающие операции тоже используют POST, чтобы HTTP и MCP имели одинаковый контракт. `GET /api/schema` возвращает доступные этому каналу операции и схемы. [OpenAPI](docs/openapi.json) генерируется командой `npm run api:docs` из [contracts.ts](src/contracts.ts).

| Область | Основные операции |
|---|---|
| Стартовый экран | `workspace_get`, `project_get`, `work_item_get` |
| Проекты и задачи | `project_create/update/archive/restore`, `work_item_create/update/complete/archive/restore` |
| Материалы | `artifact_add/version_create/link/get` |
| Решения | `proposal_record/accept/revoke` |
| Контекст и запуск | `context_prepare/get`, `run_create/get`, `claim_run`, `save_run_result`, `run_transition/resume/cancel`, `dispatch_report` |
| Внимание и история | `attention_list/update`, `request_attention`, `history_get`, `search` |
| Навыки и MCP | `skills_list`, `skill_register/select_version/package_read`, `connector_register`, `capability_observe`, `capabilities_list` |
| Регулярная работа | `recurring_job_save/activate/pause/retire`, `recurring_jobs_list` |
| Проверка операции и экспорт | `operation_status_get`, `workspace_export` |

Операция изменения принимает UUID `operation_id`. Повтор того же запроса возвращает исходный committed результат; тот же UUID с другим payload даёт `409 operation_conflict`. Изменения существующих объектов проверяют `expected_revision`; конфликт даёт `409 revision_conflict` и текущую ревизию. Объект, receipt и audit сохраняются в одной транзакции. Все owner-запросы сериализованы advisory lock одного персонального workspace; это сознательная простая реализация для масштаба 7 проектов/40+ подпроектов.

Ответ:

```json
{
  "data": {},
  "receipt": {"operation_id": "uuid", "replayed": false},
  "server_time": "UTC timestamp"
}
```

Для чтения нет receipt. Ошибки возвращают код без SQL, stack trace, токенов и provider body. Открытие страницы и выбор задачи читают состояние; они не создают Run и не включают расписание.

## Авторизация интерфейса, модели и worker

`POST /api/ui/session` обменивает проверенный UI JWT на HttpOnly cookie и CSRF token. Проверяются issuer, audience, subject и `azp` разрешённого UI client. Для UI изменений обязательны exact Origin и `X-CSRF-Token`. В development вместо UI JWT можно передать `{"bootstrap_secret":"<DEV_HUMAN_SECRET>"}` с настроенным Origin.

Модель использует другой audience и Bearer JWT; development — отдельный `DEV_MODEL_TOKEN`. Она может подготовить и записать предложение, но не принять решение, завершить/архивировать задачу, архивировать проект или управлять расписанием. Эти операции отсутствуют в MCP и запрещены через MCP даже с UI cookie. `owner_id`, channel и признак «человек» из клиентского payload не принимаются.

`POST /mcp` — stateless Streamable HTTP, официальный MCP SDK. На успешный `claim_run` транспорт отдельно выдаёт `execution_token` сроком один час. Его передают через `X-Execution-Token` или одноимённый аргумент инструмента. Токен связан с owner, Run, attempt, executor и claimant. В receipts, audit, экспорт и snapshot он не записывается. Смена владельца lease отсекает старый токен. Credential сервиса worker сам по себе не даёт доступ к файлам — нужен подтверждённый запуск.

Целевая host OAuth интеграция и поведение cookie в настоящих embedded web/desktop клиентах ещё требуют проверки G04. Проверка локального подписанного JWT не подменяет эту проверку.

## Контекст, результаты и навыки

Snapshot сохраняет точные версии связанных материалов, принятые решения и продолжение, выбранные полные SkillVersions, полномочия, цель, executor и, для worker, модель и мягкий бюджет. Материалы, SkillVersions и snapshots защищены SQL-триггерами от изменения/удаления.

Результат содержит evidence status, реальные evidence и limitations. Успех Run не завершает задачу и не меняет текущие материалы. Изменившиеся входы/решения дают stale candidate. После отмены даже поздний результат сохраняется только как неприменённое свидетельство. Архивирование требует паузы расписаний и подтверждённого терминального состояния запуска; `unknown` блокирует архив.

Файлы до 8 MiB передаются base64, проверяются SHA-256, сохраняются в private S3 или local store. Metadata появляется только после проверки bytes. Возможны неподключённые staged blobs при rollback; они не обозначаются готовыми материалами. Для внешнего источника URL и `observed_revision` остаются ссылкой и наблюдением — backend не заявляет наличие его копии или актуальность без новой сверки.

`skill_register` принимает весь owned package: `SKILL.md`, references, scripts и assets с manifest/digests. Выбор новой версии не меняет старые snapshots. Platform/third-party зависимости хранятся как ссылки без копирования принадлежащего им исходника. Реальные пользовательские пакеты в этой поставке не переносились; короткие test fixtures не являются версиями ваших навыков.

## Worker и расписания

Worker отключён до настройки `OPENAI_API_KEY`, `WORKER_MODEL`, HTTPS `WORKER_MCP_URL` и выбора модели/мягкого бюджета для запуска. API оплачивается отдельно. Budget сохраняется как явная **soft** граница; гарантированного денежного отсечения и фактического cost accounting эта версия не обещает.

```sh
npm run worker
```

Стандартный worker использует Agents API с `environment: none`, без shell/browser/computer, публикации, удаления, оплаты и внешних записей. Его MCP allowlist: `context_get`, `artifact_get`, `skill_package_read`, `capabilities_list`, `external_mcp_read`; данные ограничены snapshot и разрешёнными ресурсами. Локи и Work Engine должны быть зарегистрированы полными owned версиями и выбраны для worker. Профильные requirements участвуют в execution preflight; обсуждение проверяет только нужные ему возможности.

Worker исполняет работу с внутренними материалами workspace и с внешними источниками через настроенный readonly gateway ниже. Для собственного connector можно задать `WORKER_WORKSPACE_CONNECTOR_ID` с capability `workspace.read`. Настроенная в host OAuth-связь сама по себе не даёт доступ backend. Ненастроенные dependencies дают preflight obstacle. Native/desktop execution выполняется клиентским bridge; backend возвращает dispatch intent, а receipt отправки не считается началом выполнения.

## Полные пакеты навыков

```sh
npm run skill:pack -- --directory /path/to/owned-skill --name loki --version 1 --source-ref owned:loki --output /tmp/loki-package.json
```

Команда создаёт JSON для `skill_register`, сохраняет все файлы каталога (включая references/scripts/assets и binary bytes), сортирует manifest и вычисляет SHA-256. Она не подключает БД и не устанавливает навык. Можно добавить `--metadata metadata.json` с `requirements` и `triggers`. Для регистрации через human UI API добавьте новый `operation_id`; для обновления — `id` и актуальный `expected_revision`. Повтор того же operation ID возвращает ту же версию, новая версия сохраняет старую. Platform/third-party packages остаются ссылками.

Предел пакета — 500 файлов / 8 MiB; symlinks, контрольные символы в путях, `.env`, `.git` и `node_modules` отклоняются целиком. Такие каталоги нужно подготовить до упаковки; файлы молча не исключаются. JSON создаётся с mode 0600 и без перезаписи существующего файла. Скрипты хранятся как bytes, worker их не исполняет.

## Внешние MCP

Скопируйте `config/external-mcp.example.json` в `config/external-mcp.json`, замените connector UUID на созданный через human `connector_register` (`transport=http`, `location=remote`) и настройте HTTPS endpoint, реальные tool names и аргументы сервиса. `metadata.identity_ref` connector, identity_ref конфигурации и наблюдения должны совпадать. `EXTERNAL_MCP_CONFIG` указывает путь; токен находится только в переменной из `token_env`. Рабочая конфигурация игнорируется Git; endpoint/credentials не попадают в snapshot или экспорт. У внешнего аккаунта должны быть отдельные права только на чтение: `read_only_credentials=true` фиксирует проверенное оператором условие, но не меняет права провайдера.

```sh
npm run mcp:probe -- --config config/external-mcp.json --connector CONNECTOR_UUID
```

Probe выполняет initialize/listTools через реальный SDK и возвращает discovery/hints; не вызывает инструменты и не записывает capability observation. После проверки identity и прав у провайдера человек сохраняет `capability_observe` для нужного executor с `configured/reachable/authenticated/allowed=true`, `actions=["read"]` и сроком актуальности. ReadOnlyHint — дополнительная проверка, а полномочия обеспечиваются серверным allowlist, grants и provider credential scopes.

Для чтения создайте и примите human permission в области задачи: `body.actions=["CONNECTOR_UUID:documents.read:read"]`, `body.resources=["DOCUMENT_ID"]`. Выберите permission ID в `authorization_refs` и `{connector_id,capability:"documents.read",action:"read"}` в requirements контекста/навыка. Snapshot содержит выбранные grants, чтобы исполнителю были известны разрешённые ресурсы. `capabilities_list` показывает настроенные methods без endpoint/token.

`external_mcp_read` принимает только `{connector_id,tool_name,resource}` плюс execution token транспорта. Требуются claimed running execution Run, совпадающие executor/attempt/claimant, действующая lease, активная задача, snapshot requirement, свежая observation, совпадающая identity и принятое разрешение на точный ресурс. Остальные аргументы задаёт сервер; wildcard ресурсов нет. Во время сети DB owner-lock не удерживается. Отмена и отзыв permission могут завершиться, затем повторная проверка отбрасывает поздний ответ. Текст/structured result помечаются untrusted, известные gateway credentials удаляются из ответа; binary/resource links не возвращаются и не загружаются. Ошибки не раскрывают transport сообщения или credentials. Audit успешного чтения хранит tool name и resource hash.

Gateway использует SDK 1.31.0 и согласует поддерживаемую им legacy-ветку MCP (2025-11-25 и ниже). Поддержка текущей 2026-07-28 stateless спецификации у этого SDK не заявляется. Discovery ограничен 20 страницами, ответ — 2 MiB, общий network deadline — 15 секунд, перенаправления запрещены. Нет arbitrary headers, stdio, автоматического OAuth discovery/refresh или наследования host tokens. Неподдерживаемый сервер, expired bearer или контракт дают явный отказ; подключения настоящих сервисов проверяются отдельно.

Перед provider create сохраняется durable intent, затем session ID. При неоднозначном создании повтор запрещён. Worker восстанавливает известную сессию по ID; известный ответ create сохраняется даже после передачи lease. Только сохранённый финальный ответ завершённого root turn считается результатом; `idle` и webhook не означают успех задачи.

Отмена сохраняется до отправки provider запроса и никогда не очищается. После 202 worker ждёт подтверждения. Человеческий `run_resume` с ответом для поддерживаемого text-waiting turn создаёт durable input, отправляется один раз с Idempotency-Key и ждёт **нового** root turn. Required tool/approval actions не подменяются текстовым ответом: возвращается `provider_action_requires_adapter`.

Daily/weekly/interval поддерживают IANA timezone; default workspace — Europe/Moscow. При DST gap слот пропускается с «Вниманием»; при fold выполняется первое вхождение один раз. Уникальны job/revision/planned UTC, один активный Run на job. Простой не создаёт очередь догоняющей работы. Допуск обычного scheduler tick — 10 секунд; более старые слоты отмечаются пропущенными. За tick записывается до 1000 пропущенных occurrence на job; остаток длительного простоя отражается отдельным препятствием и требует сверки. `pause` прекращает будущие occurrence; `retire` требует паузы/остановки и сохраняет историю. Редактирование/активация/пауза retired job запрещены.

`POST /webhooks/openai` проверяет подпись официальным OpenAI SDK по raw body, временной допуск и duplicate payload. Durable inbox сохраняет только IDs, type и hash; worker сверяет provider состояние. Неизвестные ID не создают Run. Для reference-only внешнего расписания нет обещания паузы; неизвестный исход старой паузы блокирует замену и архив.

## Экспорт и восстановление

```sh
npm run export -- export.json
```

Экспорт включает данные workspace, exact file bytes, пакеты навыков, receipts/audit и hash manifest. Server OAuth/API/signing secrets не входят в экспорт. Файл создаётся mode 0600 без перезаписи существующего пути.

Для восстановления задайте **новую пустую** отдельную БД, сохраните исходный OWNER_ID, выполните миграции, затем:

```sh
npm run restore -- export.json
```

Restore проверяет формат, owner, таблицы, metadata/files hashes и существование всех blobs. В непустую БД он не пишет; вставка domain rows — одна транзакция. Сохранённые расписания могут содержать active state: **не запускайте worker на восстановленной копии, пока не исключён второй исполнитель старой установки и не проверены credentials/preflight**. Данные и auth настраиваются отдельно. Production S3 restore отдельно проходит выпускную проверку; локальный JSON roundtrip протестирован.

## Проверки и демонстрационные данные

```sh
npm run typecheck
npm run build
npm test
npm run format:check
npm run fixture
```

Тестовая PostgreSQL запускается на private Unix socket в отдельном temporary directory, без TCP и создания OS account. На Linux x64 при root используется уже существующий UID 65534, иначе текущий непривилегированный пользователь. На другой платформе нужна адаптация test harness; серверный код и обычная PostgreSQL не зависят от embedded test binary.

Fixture разрешён только вне production и для пустого workspace: 7 корневых проектов, 41 подпроект, 20 **draft** расписаний и 5 демонстрационных пунктов внимания. Ничего не запускается и реальные данные не импортируются.

Независимые regression tests проверяют scope, человеческие полномочия, CAS, cancellation/lease races, stale decisions, archive, DST, downtime, retire, external MCP resource grants и полные skill packages. [Результаты проверки и оставшиеся интеграционные gates](docs/VERIFICATION.md). В этой поставке не проверялись настоящие host web/desktop, платные Agents API вызовы, production issuer, S3 и реальные внешние connector accounts.

### Navigation inside the workspace

Projects, tasks, attention events, materials, project creation and owner login replace the main content in the same screen. The local navigation stack works in both HTTP and sandboxed MCP views without document navigation, modal dialogs or overlays. Back restores the previous screen and dashboard context (search, active/archive, attention filter and loaded range, scroll and focus). The Projects menu returns to the dashboard. A short fade animates each screen; reduced-motion disables it. Only one screen participates in layout, including during transitions. Long titles/content wrap on narrow screens. Existing automatic refresh continues while a detail or form is open. Login reconnects the existing transport without reloading the document. No additional sidebar modules or execution capabilities are enabled.
