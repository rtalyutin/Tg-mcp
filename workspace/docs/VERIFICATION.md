# Проверка backend 1.0.1 — 30.09.2026

Статус: серверный код подготовлен и проверен локально. [Сырой итоговый прогон](test-run.txt): **102 теста, 102 PASS, 0 FAIL, 0 SKIP**, 46.20 секунды. Node 24.19.0, PostgreSQL 18.4 из embedded test package, Linux x64.

| Проверка | Evidence | Статус |
|---|---|---|
| Типы, сборка, форматирование | npm run typecheck / build / format:check | PASS |
| Реальный старт compiled сервера | Отдельный процесс, /ready и authenticated dashboard | PASS |
| Данные для масштаба панели | 7 root / 41 child / 20 draft routines, 0 Run | PASS |
| Поведение domain/SQL | Core и independent tests: CAS/idempotency, tree, version immutability, archive, cancel, stale | PASS |
| Независимая проверка | 10 security-regression сценариев, отдельный verifier; найденные scope/dependency/lease/retire дефекты исправлены и повторно проверены | PASS для выполненных сценариев |
| HTTP/MCP | Настоящий официальный MCP client с локальным HTTP endpoint и PostgreSQL; отдельные transport tests | PASS |
| JWT и human/model separation | Локальный JWKS, действительные подписи, subject/audience/azp, CSRF; валидная model identity не выполняет human actions | PASS локально |
| Signed webhook | Официальный SDK, raw body, bad signature и duplicate; idle не завершает Run | PASS локально |
| Scheduler | DST gap/fold, unique slot, overlap, pause/retire, downtime без work backfill | PASS |
| Worker recovery/cancel/reply | Контролируемые provider doubles и race barriers, реальная БД; без внешних API вызовов | PASS для локального adapter contract |
| Экспорт/restore | JSON serialization, hashes, exact bytes, новая пустая PostgreSQL база, отказ непустой БД | PASS локально |
| Agents REST adapter | 25 transport double сценариев; таймауты, redaction, final output, respond acceptance | PASS локально |
| Реальный Agents API / закрытый UI | Ключ, целевая модель и бюджет не предоставлены; платных вызовов не было | BLOCKED |
| Настоящие host web/desktop, pane и local bridge | Клиентская часть не входит в эту поставку; G01/G02/G04/G05 | BLOCKED |
| Production issuer и embedded cookie | Проверен локальный JWT механизм, целевой host/client ещё не подключён | BLOCKED |
| Production S3 / Docker deployment / реальные external MCP accounts | Сторонние endpoints и credentials не предоставлены, выпуск не выполнялся | BLOCKED |

Проверка не означает принятие всего ТЗ на настоящих клиентах. G01–G05 подтверждаются при интеграции. Каталог MCP не даёт worker доступ к host OAuth. Настроенный gateway выполняет чтение разрешённых внешних ресурсов через backend; его transport проверен с настоящим SDK и локальным сервером, не с пользовательскими provider accounts. Soft budget записан явно; hard money cutoff отсутствует.

Продолжение добавило `skill:pack`, `mcp:probe` и `external_mcp_read`. Пакеты сохраняют полные nested UTF8/CRLF/binary bytes; symlinks, небезопасные paths, credential/dependency directories, некорректный base64 и oversized packages отклоняются. CLI не подключает БД и не устанавливает пакеты.

Gateway проверен реальным HTTP MCP SDK client с временной PostgreSQL и через собственный backend MCP endpoint с scoped execution token. Пройдены exact resource, no scope, wrong owner/attempt/claimant, expired lease, connector/observation identity, unavailable credentials, hint, redirect, oversized body и generic tool error случаи. Cancel/revoke commit проходят до окончания медленного чтения; поздний ответ отбрасывается. Snapshot содержит selected grants; identity mismatch даёт preflight obstacle и unavailable capability. Catalog проверен на втором page, повторённом cursor и 20-page cutoff. Credentials удаляются из text/structured outputs; resource links не загружаются. Успешный audit содержит tool name и resource hash.

Независимый verifier выполнил **15/15 PASS**, 0 SKIP, 6.313 секунды: [сырой лог](independent-test-run.txt), [fingerprints проверенной рабочей копии](independent-source.sha256). SHA256 лога: `16f517c2dad25cd3cba95bf1a0b0431bcd59f731d96bbc7d1dd149c0158188d8`. Root сверил каждый source fingerprint (`sha256sum -c`: все OK) и затем выполнил общий 102-test прогон. Старое evidence 72/72 относится к baseline commit `aed4a2838f566b5ce915a37fb88c526026dd6cb1`; оно сохранено в истории Git, а текущий test-run.txt отражает объединённую рабочую копию 1.0.1.

Один minor correctness defect воспроизведён до исправления: упаковщик принимал filename с control byte, который регистрация отвергала. Исправление в `packOwnedSkill` выровняло path validation; distinguishing regression PASS. Основные исходники после итогового полного прогона не менялись.

Пределы заключения: реальная identity внешнего provider и readonly credential scopes требуют проверки у выбранного сервиса. Gateway configuration assertion и `readOnlyHint` их не обеспечивают. Проверенные протоколы — SDK 1.31.0 / 2025-11-25 и поддерживаемые SDK предыдущие ветки; современная MCP 2026-07-28, настоящий host pane, OAuth refresh и production rollout этим evidence не подтверждены.
