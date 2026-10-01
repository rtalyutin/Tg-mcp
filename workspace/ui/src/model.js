export const attentionKinds = {
  decision_required: {
    label: "Нужно решение",
    tone: "amber",
    icon: "alert",
    action: "Открыть вопрос",
  },
  result_ready: {
    label: "Результат готов",
    tone: "green",
    icon: "check",
    action: "Посмотреть",
  },
  obstacle: {
    label: "Есть препятствие",
    tone: "amber",
    icon: "plug",
    action: "Посмотреть причину",
  },
  change_detected: {
    label: "Есть изменения",
    tone: "violet",
    icon: "change",
    action: "Посмотреть",
  },
};
export const taskLabels = {
  planned: "Запланировано",
  active: "В работе",
  blocked: "Есть препятствие",
  completed: "Завершено",
  archived: "В архиве",
};
export const runLabels = {
  awaiting_executor: "Ожидает исполнителя",
  dispatch_unknown: "Передача не подтверждена",
  running: "Выполняется",
  waiting_user: "Ждёт решения",
  blocked: "Заблокирован",
  unknown: "Состояние уточняется",
  cancel_requested: "Отмена запрошена",
};
export function dateLabel(value, now = new Date()) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Нет изменений";
  const date = new Date(value);
  const day = (x) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(x);
  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (day(date) === day(now)) return `Сегодня, ${time}`;
  if (day(date) === day(new Date(now.getTime() - 86400000)))
    return `Вчера, ${time}`;
  return (
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "numeric",
      month: "short",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    }).format(date) + `, ${time}`
  );
}
export function rootOf(id, projects) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const visited = new Set();
  let project = byId.get(id);
  while (project?.parent_id && !visited.has(project.id)) {
    visited.add(project.id);
    const parent = byId.get(project.parent_id);
    if (!parent) break;
    project = parent;
  }
  return project?.id ?? id;
}
export function projectEvents(project, data) {
  return data.attention.filter(
    (e) => rootOf(e.project_id, data.projects) === project.id,
  );
}
export function attentionCount(projectId, projects) {
  return projects
    .filter((p) => !projectId || rootOf(p.id, projects) === projectId)
    .reduce((total, p) => total + Number(p.open_attention ?? 0), 0);
}
export function rowStatus(project, data) {
  const events = projectEvents(project, data);
  const types = new Set([
    ...events.map((e) => e.type),
    ...data.projects
      .filter((p) => rootOf(p.id, data.projects) === project.id)
      .flatMap((p) => p.attention_types ?? []),
  ]);
  if (types.has("decision_required")) return attentionKinds.decision_required;
  if (types.has("obstacle")) return attentionKinds.obstacle;
  const run = data.active_runs.find(
    (r) => rootOf(r.project_id, data.projects) === project.id,
  );
  if (run)
    return {
      label: runLabels[run.status] ?? "Запуск не завершён",
      tone: run.status === "running" ? "violet" : "muted",
      icon: "dot",
    };
  if (types.has("result_ready")) return attentionKinds.result_ready;
  if (attentionCount(project.id, data.projects) > 0)
    return { label: "Есть события", tone: "violet", icon: "dot" };
  if (project.status === "archived")
    return { label: "В архиве", tone: "muted", icon: "dot" };
  return {
    label: taskLabels[project.current_task?.status] ?? "Задача не выбрана",
    tone: "muted",
    icon: "dot",
  };
}
export function unwrap(result) {
  const envelope = result?.structuredContent ?? result;
  if (result?.isError || envelope?.error)
    throw new Error(envelope?.error?.code ?? "request_failed");
  if (!envelope || !Object.hasOwn(envelope, "data"))
    throw new Error("invalid_response");
  return { data: envelope.data, server_time: envelope.server_time };
}
