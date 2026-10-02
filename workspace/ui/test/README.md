# Проверка интерфейса

Из корня репозитория:

```sh
npm test --workspace=shared-workspace-ui
npm run build --workspace=shared-workspace-ui
```

`attributes.browser.mjs` — дополнительная авторская проверка на синтетических данных через HTTP и MCP host. Она открывает реальный Chromium на ширине 390 и 1280 px, проверяет редактирование, потерянный ответ, конфликт версий, состояния задачи и ограничения плагина. Проверка не включена в стандартный CI и не подтверждает production.

Для запуска нужны необязательные Playwright и Chromium. Можно установить их во временный каталог, сохранив зависимости проекта:

```sh
TASK_BROWSER_DEPS="$(mktemp -d)"
npm install --prefix "$TASK_BROWSER_DEPS" --no-save --package-lock=false playwright
"$TASK_BROWSER_DEPS/node_modules/.bin/playwright" install chromium
ATTRIBUTES_PLAYWRIGHT_MODULE="$TASK_BROWSER_DEPS/node_modules/playwright/index.mjs" \
ATTRIBUTES_QA_OUT="$TASK_BROWSER_DEPS/results" \
node --import tsx workspace/ui/test/attributes.browser.mjs
```

Если Playwright уже доступен проекту, достаточно `node --import tsx workspace/ui/test/attributes.browser.mjs`. По умолчанию библиотека выбирает свой установленный Chromium. Для другого браузерного исполняемого файла задайте `ATTRIBUTES_CHROMIUM`.

`ATTRIBUTES_PLAYWRIGHT_MODULE` задаёт имя или путь модуля Playwright; `ATTRIBUTES_QA_OUT` — каталог скриншотов. Без последней переменной скриншоты сохраняются в `task-attributes-browser` внутри системного временного каталога. Наблюдения выводятся в stdout как JSON по одной строке.
