// Author verification against explicitly synthetic HTTP and MCP host data.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHarness } from "./harness.mjs";

const { chromium } = await import(
  process.env.ATTRIBUTES_PLAYWRIGHT_MODULE ?? "playwright"
);
const out = resolve(
  process.env.ATTRIBUTES_QA_OUT ?? join(tmpdir(), "task-attributes-browser"),
);
await mkdir(out, { recursive: true });
const harness = await createHarness();
harness.state.data.projects[0].current_task.status = "planned";
const browser = await chromium.launch({
  ...(process.env.ATTRIBUTES_CHROMIUM
    ? { executablePath: process.env.ATTRIBUTES_CHROMIUM }
    : {}),
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
  ],
});
const page = await browser.newPage();
const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(error.message));
const log = (scenario, observation) =>
  console.log(JSON.stringify({ scenario, observation }));
const taskId = harness.state.data.projects[0].current_task.id;
const open = async (surface = page) => {
  await surface
    .getByRole("button", { name: "Открыть проект ЯКС", exact: true })
    .click();
  await surface.getByRole("button", { name: /Анонс первого тура/ }).click();
  await surface
    .getByRole("heading", { name: "Реквизиты задачи", exact: true })
    .waitFor();
};
const reason = async (value = "Синтетическая авторская проверка") =>
  page.getByLabel("Основание изменения", { exact: true }).fill(value);
const save = async () => {
  await page
    .getByRole("button", { name: "Сохранить реквизиты", exact: true })
    .click();
  await page
    .getByText("Карточка сохранена и повторно прочитана с сервера.", {
      exact: true,
    })
    .waitFor();
};

try {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(harness.url + "/workspace");
    await open();
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "В работу", exact: true })
        .isDisabled(),
      true,
    );
    const layout = await page.evaluate(() => {
      const fields = [...document.querySelectorAll(".attribute-field")].map(
        (element) => {
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        },
      );
      return {
        viewport: innerWidth,
        width: document.documentElement.scrollWidth,
        fields,
        overlaps: fields.some((a, i) =>
          fields
            .slice(i + 1)
            .some(
              (b) =>
                Math.min(a.right, b.right) > Math.max(a.x, b.x) + 1 &&
                Math.min(a.bottom, b.bottom) > Math.max(a.y, b.y) + 1,
            ),
        ),
      };
    });
    assert.equal(layout.width, width);
    assert.equal(layout.overlaps, false);
    await page.screenshot({
      path: `${out}/attributes-${width}.png`,
      fullPage: true,
    });
    log(`render-${width}`, {
      noOverlay: true,
      noHorizontalOverflow: true,
      noFieldOverlap: true,
      fields: layout.fields.length,
    });
  }

  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await page
    .getByLabel("Найти проект или материал", { exact: true })
    .fill("ЯКС");
  await page
    .getByRole("combobox", { name: "Фильтр внимания по проекту" })
    .selectOption(harness.state.data.projects[0].id);
  await open();
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  await page.getByRole("button", { name: /Анонс первого тура/ }).waitFor();
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  assert.equal(
    await page
      .getByLabel("Найти проект или материал", { exact: true })
      .inputValue(),
    "ЯКС",
  );
  assert.equal(
    await page
      .getByRole("combobox", { name: "Фильтр внимания по проекту" })
      .inputValue(),
    harness.state.data.projects[0].id,
  );
  assert.equal(await page.locator(".screen-view:not([hidden])").count(), 1);
  assert.equal(
    await page.evaluate(
      () => performance.getEntriesByType("navigation").length,
    ),
    1,
  );
  await page.getByRole("button", { name: "Новый проект", exact: true }).click();
  await page
    .getByRole("heading", { name: "Новый проект", exact: true })
    .waitFor();
  assert.equal(await page.locator("dialog[open]").count(), 0);
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  assert.equal(
    await page
      .getByLabel("Найти проект или материал", { exact: true })
      .inputValue(),
    "ЯКС",
  );
  await page.getByLabel("Найти проект или материал", { exact: true }).fill("");
  await page
    .getByRole("combobox", { name: "Фильтр внимания по проекту" })
    .selectOption("all");
  await page.setViewportSize({ width: 390, height: 900 });
  const lowerProject = page.getByRole("button", {
    name: "Открыть проект Бар",
    exact: true,
  });
  await lowerProject.scrollIntoViewIfNeeded();
  await lowerProject.focus();
  const previousScroll = await page.evaluate(() => scrollY);
  await lowerProject.click();
  await page.getByRole("heading", { name: "Бар", exact: true }).waitFor();
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  await lowerProject.waitFor();
  assert.ok(
    Math.abs((await page.evaluate(() => scrollY)) - previousScroll) <= 1,
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Открыть проект Бар",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await open();
  log("upstream-navigation-preserved", {
    backStack: true,
    searchAndAttentionFilterRetained: true,
    scrollAndFocusRestored: true,
    createInline: true,
    oneActiveScreen: true,
    noDocumentReload: true,
  });

  await page
    .getByLabel("Ответственный за результат", { exact: true })
    .fill("Synthetic owner");
  await page
    .getByLabel("Критерии приёмки", { exact: true })
    .fill("Observable A\nObservable B");
  await page.getByLabel("Бюджет", { exact: true }).fill("0");
  await page.getByLabel("Валюта", { exact: true }).selectOption("RUB");
  await page.getByLabel("Режим срока", { exact: true }).selectOption("date");
  await page
    .getByLabel("Срок: дата и время", { exact: true })
    .fill("2026-10-09T20:30:00+03:00");
  await page
    .getByLabel("Часовой пояс срока", { exact: true })
    .fill("Europe/Moscow");
  await reason();
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  await page
    .getByText(
      "В карточке есть несохранённые изменения. Сохраните их или отмените перед переходом.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByLabel("Ответственный за результат", { exact: true })
      .inputValue(),
    "Synthetic owner",
  );
  await save();
  let task = harness.state.workItems.get(taskId);
  assert.deepEqual(task.attributes.acceptance_criteria, [
    "Observable A",
    "Observable B",
  ]);
  assert.equal(task.attributes.budget, 0);
  assert.equal(task.attributes.currency, "RUB");
  assert.equal(task.attributes.due_at, "2026-10-09T20:30:00+03:00");
  log("edit-save-readback", {
    exactLists: true,
    budgetZeroPreserved: true,
    noDefaultPromotion: !Object.hasOwn(task.attributes, "task_type"),
    revision: task.revision,
  });

  await page
    .getByLabel("Ответственный за результат", { exact: true })
    .fill("My preserved draft");
  task.attributes.accountable = "Concurrent owner";
  task.attributes.budget = 20;
  task.revision++;
  await reason("Синтетическая конкуренция");
  await page
    .getByRole("button", { name: "Сохранить реквизиты", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Применить мой черновик к новой версии",
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByLabel("Ответственный за результат", { exact: true })
      .inputValue(),
    "My preserved draft",
  );
  await page
    .getByRole("button", {
      name: "Применить мой черновик к новой версии",
      exact: true,
    })
    .click();
  assert.equal(
    await page.getByLabel("Бюджет", { exact: true }).inputValue(),
    "20",
  );
  await save();
  assert.equal(task.attributes.accountable, "My preserved draft");
  assert.equal(task.attributes.budget, 20);
  log("revision-conflict", {
    draftRetained: true,
    explicitRebase: true,
    unrelatedConcurrentValueRetained: true,
  });

  harness.state.requests = [];
  harness.state.loseAttributeResponse = true;
  await page
    .getByLabel("Следующее действие", { exact: true })
    .fill("Synthetic next step");
  await reason();
  await page
    .getByRole("button", { name: "Сохранить реквизиты", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Проверить и повторить", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Следующее действие", { exact: true }).isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Проверить и повторить", exact: true })
    .click();
  await page
    .getByText("Карточка сохранена и повторно прочитана с сервера.", {
      exact: true,
    })
    .waitFor();
  const writes = harness.state.requests.filter(
    (request) => request.op === "work_item_attributes_update",
  );
  const lookups = harness.state.requests.filter(
    (request) => request.op === "operation_status_get",
  );
  assert.equal(writes.length, 1);
  assert.equal(lookups.length, 1);
  assert.equal(writes[0].input.operation_id, lookups[0].input.operation_id);
  log("unknown-response", {
    writes: writes.length,
    receiptLookups: lookups.length,
    sameOperationId: true,
  });

  await page.getByLabel("Режим срока", { exact: true }).selectOption("none");
  await reason();
  await save();
  assert.equal(task.attributes.deadline_mode, "none");
  assert.ok(!Object.hasOwn(task.attributes, "due_at"));
  log("exclusive-deadline-modes", {
    explicitNoDeadline: true,
    previousDateRemoved: true,
  });

  await page
    .getByLabel("Тип задачи", { exact: true })
    .selectOption("organization");
  await page
    .getByLabel("Ожидаемый результат", { exact: true })
    .fill("Synthetic expected result");
  await page
    .getByLabel("Исполнитель следующего действия", { exact: true })
    .fill("Synthetic executor");
  await page.getByLabel("Приоритет", { exact: true }).selectOption("normal");
  await page
    .getByLabel("Основание приоритета", { exact: true })
    .fill("Synthetic criterion");
  await page
    .getByLabel("Режим зависимостей", { exact: true })
    .selectOption("none");
  await page
    .getByLabel("Источники задачи", { exact: true })
    .fill("synthetic://browser-check");
  await reason();
  await save();
  await reason("Явный запуск синтетической задачи");
  await page.getByRole("button", { name: "В работу", exact: true }).click();
  await page
    .getByText("Карточка сохранена и повторно прочитана с сервера.", {
      exact: true,
    })
    .waitFor();
  assert.equal(task.status, "active");
  await page
    .getByLabel("Состояние выполнения", { exact: true })
    .selectOption("executed");
  await page
    .getByLabel("Состояние проверки", { exact: true })
    .selectOption("accepted");
  await page
    .getByLabel("Кто проверил результат", { exact: true })
    .fill("Synthetic human verifier");
  await page
    .getByLabel("Результат работы", { exact: true })
    .fill("synthetic://result");
  await page
    .getByLabel("Свидетельства проверки", { exact: true })
    .fill("Synthetic observation");
  await reason();
  await save();
  await reason("Явное завершение принятой работы");
  await page
    .getByRole("button", { name: "Завершить принятую работу", exact: true })
    .click();
  await page
    .getByText("Карточка сохранена и повторно прочитана с сервера.", {
      exact: true,
    })
    .waitFor();
  assert.equal(task.status, "completed");
  log("owner-state-controls", {
    activationRequiredSavedReadiness: true,
    executedSeparateFromAccepted: true,
    completionExplicitHumanClick: true,
  });

  await page.goto(harness.url + "/plugin");
  const plugin = page.frameLocator("iframe");
  await open(plugin);
  assert.equal(
    await plugin.getByLabel("Состояние проверки", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await plugin
      .getByLabel("Кто проверил результат", { exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await plugin
      .getByRole("button", { name: "Завершить принятую работу", exact: true })
      .count(),
    0,
  );
  log("plugin-owner-boundary", {
    protectedFieldsReadOnly: true,
    noCompletionButton: true,
  });
  assert.deepEqual(runtimeErrors, []);
  log("result", {
    passed: true,
    browser: browser.version(),
    scope:
      "Author synthetic browser checks; production and backend transaction verification belong to separate checks",
  });
} finally {
  await browser.close();
  await harness.close();
}
