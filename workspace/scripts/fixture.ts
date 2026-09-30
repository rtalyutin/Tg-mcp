import { readConfig, components } from "../src/config.js";
import { id } from "../src/db.js";
const config = readConfig();
if (config.NODE_ENV === "production")
  throw new Error("Synthetic fixture forbidden in production");
const { db, service } = components(config);
await service.init(config.OWNER_ID);
const actor = {
  owner_id: config.OWNER_ID,
  channel: "ui" as const,
  executor_id: "native",
};
const call = async (name: any, body: any) =>
  (await service.execute(name, { operation_id: id(), ...body }, actor)).data;
try {
  if ((await db.pool.query("SELECT 1 FROM projects LIMIT 1")).rowCount)
    throw new Error("Fixture requires an empty workspace");
  const roots = [];
  for (const title of [
    "ЯКС",
    "Бар",
    "Разработка",
    "Маркетинг",
    "Личное",
    "Исследования",
    "Операции",
  ])
    roots.push(await call("project_create", { title }));
  for (let i = 0; i < 41; i++) {
    const p = await call("project_create", {
      title: `Подпроект ${i + 1}`,
      parent_id: roots[i % 7].id,
    });
    const w = await call("work_item_create", {
      project_id: p.id,
      title: "Следующий шаг",
      goal: "Синтетический пример; требует постановки человеком",
    });
    await call("project_update", {
      id: p.id,
      expected_revision: Number(p.revision),
      current_work_item_id: w.id,
    });
  }
  for (let i = 0; i < 20; i++) {
    const root = roots[i % 7];
    const w = await call("work_item_create", {
      project_id: root.id,
      title: `Регулярная задача ${i + 1}`,
      goal: "Синтетическая задача",
    });
    await call("recurring_job_save", {
      work_item_id: w.id,
      instruction: "Синтетический пример, не активирован",
      schedule: { type: "daily", time: "09:00" },
      timezone: "Europe/Moscow",
      executor_id: "worker",
      configuration: {},
    });
  }
  for (let i = 0; i < 5; i++)
    await call("request_attention", {
      project_id: roots[i].id,
      source: "fixture",
      source_event_id: String(i),
      type: i % 2 ? "decision_required" : "obstacle",
      reason: "Демонстрационный пункт внимания",
      refs: [],
    });
  console.log(
    "Synthetic fixture: 7 projects, 41 subprojects, 20 draft routines; no runs started",
  );
} finally {
  await db.close();
}
