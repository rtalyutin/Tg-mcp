import { DomainError, hash, id, one, type Client } from "./db.js";
import { Temporal } from "@js-temporal/polyfill";

export type AttributeValue =
  string | number | boolean | (string | number | boolean)[];
export type Attributes = Record<string, AttributeValue>;
export type ParameterDefinition = {
  id?: string;
  code: string;
  label: string;
  data_type: "string" | "number" | "boolean" | "datetime" | "reference";
  multiple: boolean;
  options: string[];
  required_stage: "none" | "activation" | "blocked" | "completion";
  type_profile: string | null;
  required_when_code: string | null;
  required_when_value: string | null;
  protected: boolean;
  revision?: number;
};
const parameter = (
  code: string,
  label: string,
  extras: Partial<ParameterDefinition> = {},
): ParameterDefinition => ({
  code,
  label,
  data_type: "string",
  multiple: false,
  options: [],
  required_stage: "none",
  type_profile: null,
  required_when_code: null,
  required_when_value: null,
  protected: false,
  ...extras,
});
const activation = { required_stage: "activation" as const };
const completion = { required_stage: "completion" as const };
const list = { multiple: true };
const conditional = (code: string, value: string) => ({
  required_when_code: code,
  required_when_value: value,
});
const profile = (type_profile: string) => ({ type_profile });
/** Configuration, not task-domain SQL columns. Owners can extend it through task_parameter_define. */
export const defaultTaskParameters: ParameterDefinition[] = [
  parameter("task_type", "Тип задачи", {
    ...activation,
    options: [
      "development",
      "content",
      "partnership",
      "match",
      "research",
      "organization",
    ],
  }),
  parameter("expected_result", "Ожидаемый результат", activation),
  parameter("acceptance_criteria", "Критерии приёмки", {
    ...activation,
    ...list,
  }),
  parameter("accountable", "Ответственный за результат", activation),
  parameter("next_executor", "Исполнитель следующего действия", activation),
  parameter("priority", "Приоритет", {
    ...activation,
    options: ["critical", "high", "normal", "low"],
  }),
  parameter("priority_reason", "Основание приоритета", activation),
  parameter("deadline_mode", "Режим срока", {
    ...activation,
    options: ["unknown", "date", "event", "none"],
  }),
  parameter("due_at", "Срок: дата и время", {
    ...activation,
    data_type: "datetime",
    ...conditional("deadline_mode", "date"),
  }),
  parameter("due_timezone", "Часовой пояс срока", {
    ...activation,
    ...conditional("deadline_mode", "date"),
  }),
  parameter("due_event", "Срок: событие", {
    ...activation,
    ...conditional("deadline_mode", "event"),
  }),
  parameter("next_action", "Следующее действие", activation),
  parameter("dependency_mode", "Режим зависимостей", {
    ...activation,
    options: ["unknown", "none", "list"],
  }),
  parameter("depends_on", "Зависит от задач", {
    ...activation,
    ...list,
    data_type: "reference",
    ...conditional("dependency_mode", "list"),
  }),
  parameter("blocker_reason", "Причина блокировки", {
    required_stage: "blocked",
  }),
  parameter("unblock_condition", "Условие снятия блокировки", {
    required_stage: "blocked",
  }),
  parameter("source_refs", "Источники задачи", { ...activation, ...list }),
  parameter("constraints", "Ограничения и принятые решения", list),
  parameter("execution_state", "Состояние выполнения", {
    options: ["prepared", "executed"],
    ...completion,
  }),
  parameter("result_refs", "Результат работы", { ...completion, ...list }),
  parameter("verification_state", "Состояние проверки", {
    options: ["not_checked", "accepted", "rejected"],
    ...completion,
    protected: true,
  }),
  parameter("verified_by", "Кто проверил результат", {
    ...completion,
    protected: true,
  }),
  parameter("verification_evidence", "Свидетельства проверки", {
    ...completion,
    ...list,
  }),
  parameter("budget", "Бюджет", { data_type: "number" }),
  parameter("currency", "Валюта", {
    ...activation,
    options: ["RUB", "USD", "EUR"],
    ...conditional("budget", "present"),
  }),
  parameter("effort_hours", "Оценка трудозатрат, часы", {
    data_type: "number",
  }),
  parameter("partner_name", "Партнёр", {
    ...activation,
    ...profile("partnership"),
  }),
  parameter("partnership_terms", "Условия партнёрства", {
    ...activation,
    ...list,
    ...profile("partnership"),
  }),
  parameter("reciprocal_obligations", "Встречные обязательства", {
    ...activation,
    ...list,
    ...profile("partnership"),
  }),
  parameter("agreement_refs", "Подтверждение договорённости", {
    ...completion,
    ...list,
    ...profile("partnership"),
  }),
  parameter(
    "fulfillment_event",
    "Дата или событие исполнения партнёрства",
    profile("partnership"),
  ),
  parameter("match_teams", "Команды матча", {
    ...activation,
    ...list,
    ...profile("match"),
  }),
  parameter("match_format", "Формат матча", {
    ...activation,
    ...profile("match"),
  }),
  parameter("match_at", "Время матча", {
    ...activation,
    data_type: "datetime",
    ...profile("match"),
  }),
  parameter("match_timezone", "Часовой пояс матча", {
    ...activation,
    ...profile("match"),
  }),
  parameter("match_confirmations", "Подтверждения сторон", {
    ...completion,
    ...list,
    ...profile("match"),
  }),
  parameter("broadcast_plan", "Трансляция матча", profile("match")),
  parameter("spec_ref", "Версия ТЗ", {
    ...activation,
    ...profile("development"),
  }),
  parameter("build_ref", "Сборка или коммит", {
    ...completion,
    ...profile("development"),
  }),
  parameter("environment", "Среда", {
    ...activation,
    ...profile("development"),
  }),
  parameter("test_results", "Результаты проверок сборки", {
    ...completion,
    ...list,
    ...profile("development"),
  }),
  parameter("research_question", "Проверяемый вопрос", {
    ...activation,
    ...profile("research"),
  }),
  parameter("cost_limit", "Предел затрат исследования", {
    ...activation,
    ...profile("research"),
  }),
  parameter("stop_condition", "Условие остановки исследования", {
    ...activation,
    ...profile("research"),
  }),
];

export async function defineParameter(
  c: Client,
  owner: string,
  d: ParameterDefinition,
  seed = false,
) {
  if (
    (d.required_when_code === null) !== (d.required_when_value === null) ||
    d.required_when_code === d.code
  )
    throw new DomainError("invalid_parameter_condition");
  if (d.options.length && d.data_type !== "string")
    throw new DomainError("parameter_options_require_string");
  if (new Set(d.options).size !== d.options.length)
    throw new DomainError("duplicate_parameter_options");
  const existing = (
    await c.query(
      "SELECT * FROM entity_parameters WHERE owner_id=$1 AND entity_type='task' AND code=$2",
      [owner, d.code],
    )
  ).rows[0];
  if (existing && seed) return existing;
  const core = defaultTaskParameters.find((x) => x.code === d.code);
  if (
    existing &&
    core &&
    [
      "data_type",
      "multiple",
      "required_stage",
      "type_profile",
      "required_when_code",
      "required_when_value",
      "protected",
    ].some((key) => (d as any)[key] !== (core as any)[key])
  )
    throw new DomainError("core_parameter_contract", 409);
  if (
    existing &&
    core &&
    (d.code === "task_type"
      ? core.options.some((option) => !d.options.includes(option))
      : hash(d.options) !== hash(core.options))
  )
    throw new DomainError("core_parameter_contract", 409);
  if (d.required_when_code) {
    await one(
      c,
      "SELECT id FROM entity_parameters WHERE owner_id=$1 AND entity_type='task' AND code=$2",
      [owner, d.required_when_code],
    );
  }
  if (d.type_profile) {
    await one(
      c,
      "SELECT value FROM entity_parameter_options o JOIN entity_parameters p ON p.id=o.parameter_id AND p.owner_id=o.owner_id AND p.entity_type=o.entity_type WHERE p.owner_id=$1 AND p.code='task_type' AND o.value=$2",
      [owner, d.type_profile],
    );
  }
  let row;
  if (existing) {
    const expected = (d as ParameterDefinition & { expected_revision?: number })
      .expected_revision;
    if (expected !== Number(existing.revision))
      throw new DomainError("revision_conflict", 409, {
        current_revision: Number(existing.revision),
      });
    const values = (
      await c.query(
        "SELECT * FROM entity_parameter_values WHERE owner_id=$1 AND entity_type='task' AND parameter_id=$2",
        [owner, existing.id],
      )
    ).rows;
    if (
      values.length &&
      (existing.data_type !== d.data_type || existing.multiple !== d.multiple)
    )
      throw new DomainError("parameter_type_in_use", 409);
    if (
      d.options.length &&
      values.some((v) => !d.options.includes(v.value_text))
    )
      throw new DomainError("parameter_option_in_use", 409);
    if (
      ["verification_state", "verified_by"].includes(d.code) &&
      (!d.protected || d.data_type !== "string" || d.multiple)
    )
      throw new DomainError("protected_parameter_contract", 409);
    row = await one(
      c,
      "UPDATE entity_parameters SET label=$3,data_type=$4,multiple=$5,required_stage=$6,type_profile=$7,required_when_code=$8,required_when_value=$9,protected=$10,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
      [
        owner,
        existing.id,
        d.label,
        d.data_type,
        d.multiple,
        d.required_stage,
        d.type_profile,
        d.required_when_code,
        d.required_when_value,
        d.protected,
      ],
    );
    await c.query(
      "DELETE FROM entity_parameter_options WHERE owner_id=$1 AND entity_type='task' AND parameter_id=$2",
      [owner, row.id],
    );
  } else
    row = await one(
      c,
      "INSERT INTO entity_parameters(id,owner_id,entity_type,code,label,data_type,multiple,required_stage,type_profile,required_when_code,required_when_value,protected) VALUES($1,$2,'task',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
      [
        id(),
        owner,
        d.code,
        d.label,
        d.data_type,
        d.multiple,
        d.required_stage,
        d.type_profile,
        d.required_when_code,
        d.required_when_value,
        d.protected,
      ],
    );
  for (let i = 0; i < d.options.length; i++)
    await c.query(
      "INSERT INTO entity_parameter_options(owner_id,entity_type,parameter_id,value,ordinal) VALUES($1,'task',$2,$3,$4)",
      [owner, row.id, d.options[i], i],
    );
  return row;
}
export async function seedTaskParameters(c: Client, owner: string) {
  for (const d of defaultTaskParameters)
    await defineParameter(c, owner, d, true);
}
export async function taskParameterList(
  c: Client,
  owner: string,
): Promise<ParameterDefinition[]> {
  return (
    await c.query(
      "SELECT p.*,COALESCE((SELECT array_agg(o.value ORDER BY o.ordinal) FROM entity_parameter_options o WHERE o.owner_id=p.owner_id AND o.entity_type=p.entity_type AND o.parameter_id=p.id),ARRAY[]::text[]) options FROM entity_parameters p WHERE owner_id=$1 AND entity_type='task' ORDER BY p.created_at,p.code",
      [owner],
    )
  ).rows.map((d) => ({ ...d, revision: Number(d.revision) }));
}
export async function taskAttributes(
  c: Client,
  owner: string,
  work: string,
): Promise<Attributes> {
  const rows = (
    await c.query(
      "SELECT p.code,v.* FROM entity_parameter_values v JOIN entity_parameters p ON p.owner_id=v.owner_id AND p.entity_type=v.entity_type AND p.id=v.parameter_id WHERE v.owner_id=$1 AND v.entity_type='task' AND v.entity_id=$2 ORDER BY p.code,v.ordinal",
      [owner, work],
    )
  ).rows;
  const attributes: Attributes = {};
  for (const v of rows) {
    const value =
      v.data_type === "number"
        ? Number(v.value_number)
        : v.data_type === "datetime"
          ? new Date(v.value_datetime).toISOString()
          : v.data_type === "boolean"
            ? v.value_boolean
            : v.data_type === "reference"
              ? v.value_ref
              : v.value_text;
    if (v.multiple)
      (attributes[v.code] ??= []) as (string | number | boolean)[];
    if (v.multiple)
      (attributes[v.code] as (string | number | boolean)[]).push(value);
    else attributes[v.code] = value;
  }
  return attributes;
}
const present = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  (!Array.isArray(value) || value.length > 0);
export function taskReadiness(
  definitions: ParameterDefinition[],
  attributes: Attributes,
  stage: "activation" | "blocked" | "completion" = "activation",
) {
  const missing: { code: string; label: string }[] = [];
  for (const d of definitions) {
    if (
      d.required_stage !== stage &&
      !(stage === "completion" && d.required_stage === "activation")
    )
      continue;
    if (d.type_profile && attributes.task_type !== d.type_profile) continue;
    if (
      d.required_when_code &&
      (d.required_when_value === "present"
        ? !present(attributes[d.required_when_code])
        : attributes[d.required_when_code] !== d.required_when_value)
    )
      continue;
    if (
      !present(attributes[d.code]) ||
      (["deadline_mode", "dependency_mode"].includes(d.code) &&
        attributes[d.code] === "unknown")
    )
      missing.push({ code: d.code, label: d.label });
  }
  if (stage === "completion") {
    for (const [code, expected] of [
      ["execution_state", "executed"],
      ["verification_state", "accepted"],
    ]) {
      if (
        attributes[code!] !== expected &&
        !missing.some((x) => x.code === code)
      )
        missing.push({
          code: code!,
          label: definitions.find((d) => d.code === code)?.label ?? code!,
        });
    }
  }
  return { ready: missing.length === 0, missing };
}
export function requireReadiness(
  definitions: ParameterDefinition[],
  attributes: Attributes,
  stage: "activation" | "blocked" | "completion",
) {
  const readiness = taskReadiness(definitions, attributes, stage);
  if (!readiness.ready)
    throw new DomainError("task_attributes_required", 409, {
      stage,
      ...readiness,
    });
}
function timezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    throw new DomainError("invalid_task_timezone", 400, { value });
  }
}
function instant(value: string) {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(
      value,
    )
  )
    return false;
  try {
    Temporal.Instant.from(value);
    return true;
  } catch {
    return false;
  }
}
export function validateTaskAttributes(
  definitions: ParameterDefinition[],
  attributes: Attributes,
) {
  for (const [code, raw] of Object.entries(attributes)) {
    const d = definitions.find((x) => x.code === code);
    if (!d) throw new DomainError("unknown_task_parameter", 400, { code });
    if (d.multiple !== Array.isArray(raw))
      throw new DomainError("invalid_task_parameter_cardinality", 400, {
        code,
      });
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > 100)
      throw new DomainError("task_parameter_too_many_values", 400, { code });
    for (const v of values) {
      const valid =
        d.data_type === "number"
          ? typeof v === "number" && Number.isFinite(v)
          : d.data_type === "boolean"
            ? typeof v === "boolean"
            : typeof v === "string" &&
              v.trim().length > 0 &&
              v.length <= 20000 &&
              (d.data_type !== "reference" ||
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                  v,
                )) &&
              (d.data_type !== "datetime" || instant(v));
      if (!valid || (d.options.length > 0 && !d.options.includes(String(v))))
        throw new DomainError("invalid_task_parameter_value", 400, { code });
    }
    if (new Set(values).size !== values.length)
      throw new DomainError("duplicate_task_parameter_values", 400, { code });
  }
  for (const key of ["due_timezone", "match_timezone"])
    if (typeof attributes[key] === "string")
      timezone(attributes[key] as string);
  for (const key of ["budget", "effort_hours"])
    if (typeof attributes[key] === "number" && (attributes[key] as number) < 0)
      throw new DomainError("negative_task_parameter", 400, { code: key });
  if (
    attributes.deadline_mode &&
    attributes.deadline_mode !== "date" &&
    (present(attributes.due_at) || present(attributes.due_timezone))
  )
    throw new DomainError("task_deadline_mode_conflict");
  if (
    attributes.deadline_mode &&
    attributes.deadline_mode !== "event" &&
    present(attributes.due_event)
  )
    throw new DomainError("task_deadline_mode_conflict");
  if (
    attributes.dependency_mode &&
    attributes.dependency_mode !== "list" &&
    present(attributes.depends_on)
  )
    throw new DomainError("task_dependency_mode_conflict");
  if (
    present(attributes.match_teams) &&
    (attributes.match_teams as string[]).length !== 2
  )
    throw new DomainError("match_requires_two_teams");
}
export async function writeTaskAttributes(
  c: Client,
  owner: string,
  work: string,
  definitions: ParameterDefinition[],
  patch: Record<string, AttributeValue | null>,
  channel: string,
  forceInvalidate = false,
) {
  const before = await taskAttributes(c, owner, work);
  const attributes = { ...before };
  const effectivePatch = { ...patch };
  for (const [code, v] of Object.entries(patch)) {
    const d = definitions.find((x) => x.code === code);
    if (!d) throw new DomainError("unknown_task_parameter", 400, { code });
    if (
      (d.protected || ["verification_state", "verified_by"].includes(code)) &&
      channel !== "ui"
    )
      throw new DomainError("human_ui_required", 403, { code });
    if (v === null) delete attributes[code];
    else attributes[code] = v;
  }
  if (
    before.verification_state === "accepted" &&
    (forceInvalidate ||
      Object.entries(patch).some(
        ([code, value]) =>
          ![
            "verification_state",
            "verified_by",
            "verification_evidence",
          ].includes(code) && hash(before[code] ?? null) !== hash(value),
      ))
  ) {
    attributes.verification_state = "not_checked";
    delete attributes.verified_by;
    delete attributes.verification_evidence;
    effectivePatch.verification_state = "not_checked";
    effectivePatch.verified_by = null;
    effectivePatch.verification_evidence = null;
  }
  validateTaskAttributes(definitions, attributes);
  const refs = Object.entries(attributes).flatMap(([code, v]) =>
    definitions.find((x) => x.code === code)?.data_type === "reference"
      ? Array.isArray(v)
        ? v
        : [v]
      : [],
  ) as string[];
  for (const ref of refs) {
    if (ref === work) throw new DomainError("task_dependency_self", 409);
    await one(
      c,
      "SELECT id FROM entities WHERE owner_id=$1 AND entity_type='task' AND id=$2",
      [owner, ref],
    );
  }
  const dependencies = (attributes.depends_on ?? []) as string[];
  if (dependencies.length) {
    const cycle = await c.query(
      "WITH RECURSIVE reachable(id) AS (SELECT unnest($3::uuid[]) UNION SELECT v.value_ref FROM entity_parameter_values v JOIN entity_parameters p ON p.owner_id=v.owner_id AND p.entity_type=v.entity_type AND p.id=v.parameter_id JOIN reachable r ON r.id=v.entity_id WHERE v.owner_id=$1 AND v.entity_type='task' AND p.code='depends_on') SELECT id FROM reachable WHERE id=$2 LIMIT 1",
      [owner, work, dependencies],
    );
    if (cycle.rowCount) throw new DomainError("task_dependency_cycle", 409);
  }
  for (const [code, value] of Object.entries(effectivePatch)) {
    const d = definitions.find((x) => x.code === code)!;
    await c.query(
      "DELETE FROM entity_parameter_values WHERE owner_id=$1 AND entity_type='task' AND entity_id=$2 AND parameter_id=$3",
      [owner, work, d.id],
    );
    if (value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      await c.query(
        "INSERT INTO entity_parameter_values(owner_id,entity_type,entity_id,parameter_id,data_type,multiple,ordinal,value_text,value_number,value_boolean,value_datetime,value_ref) VALUES($1,'task',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          owner,
          work,
          d.id,
          d.data_type,
          d.multiple,
          i,
          d.data_type === "string" ? v : null,
          d.data_type === "number" ? v : null,
          d.data_type === "boolean" ? v : null,
          d.data_type === "datetime" ? v : null,
          d.data_type === "reference" ? v : null,
        ],
      );
    }
  }
  return attributes;
}

/** One-time, owner-scoped import of confirmed facts from the earlier YCS content package.
 * Deliberately ignores source statuses, event dates, related_tasks, proposals and inferred types.
 * The ledger prevents a later restart from restoring values an owner deliberately cleared.
 */
export async function backfillContextAttributes(c: Client, owner: string) {
  const rows = (
    await c.query(
      "SELECT l.work_item_id,v.id version_id,v.artifact_id,v.content FROM artifact_links l JOIN artifacts a ON a.owner_id=l.owner_id AND a.id=l.artifact_id JOIN artifact_versions v ON v.owner_id=a.owner_id AND v.artifact_id=a.id AND v.id=a.current_version_id JOIN work_items w ON w.owner_id=l.owner_id AND w.id=l.work_item_id WHERE l.owner_id=$1 AND w.status='planned' AND a.kind='text' ORDER BY v.created_at DESC",
      [owner],
    )
  ).rows;
  const contexts = new Map<
    string,
    { work: string; version: string; artifact: string; body: any }
  >();
  for (const r of rows) {
    if (contexts.has(r.work_item_id)) continue;
    try {
      const body = JSON.parse(r.content);
      if (
        body?.schema === "ycs-task-context/1" &&
        body.card &&
        typeof body.card.key === "string"
      )
        contexts.set(r.work_item_id, {
          work: r.work_item_id,
          version: r.version_id,
          artifact: r.artifact_id,
          body,
        });
    } catch {
      /* Other text materials are not task-import contracts. */
    }
  }
  const keys = new Map<string, string[]>();
  for (const x of contexts.values())
    keys.set(x.body.card.key, [...(keys.get(x.body.card.key) ?? []), x.work]);
  const definitions = await taskParameterList(c, owner);
  const stringList = (x: unknown) =>
    Array.isArray(x)
      ? x.filter(
          (s): s is string =>
            typeof s === "string" && s.trim().length > 0 && s.length <= 20000,
        )
      : [];
  const sentence = (x: any) =>
    typeof x === "string" ? x : x && typeof x.text === "string" ? x.text : null;
  const unique = (x: string[]) => [...new Set(x)].slice(0, 100);
  for (const x of contexts.values()) {
    if (
      (
        await c.query(
          "SELECT 1 FROM entity_attribute_imports WHERE owner_id=$1 AND entity_type='task' AND entity_id=$2",
          [owner, x.work],
        )
      ).rowCount
    )
      continue;
    const card = x.body.card;
    const existing = await taskAttributes(c, owner, x.work);
    const patch: Record<string, AttributeValue | null> = {};
    if (
      typeof card.goal === "string" &&
      card.goal.trim() &&
      card.goal.length <= 20000 &&
      existing.expected_result === undefined
    )
      patch.expected_result = card.goal;
    if (
      typeof card.next_step === "string" &&
      card.next_step.trim() &&
      card.next_step.length <= 20000 &&
      existing.next_action === undefined
    )
      patch.next_action = card.next_step;
    const sources = unique([
      ...stringList(card.source_refs),
      ...(Array.isArray(card.evidence) ? card.evidence : []).flatMap((e: any) =>
        stringList(e?.source_refs),
      ),
      ...(Array.isArray(card.materials) ? card.materials : []).flatMap(
        (m: any) => (typeof m?.ref === "string" ? [m.ref] : []),
      ),
      ...(Array.isArray(card.accepted_decisions)
        ? card.accepted_decisions
        : []
      ).flatMap((d: any) => stringList(d?.source_refs)),
      ...(Array.isArray(card.user_corrections)
        ? card.user_corrections
        : []
      ).flatMap((d: any) => stringList(d?.source_refs)),
    ]);
    if (sources.length && existing.source_refs === undefined)
      patch.source_refs = sources;
    const constraints = unique([
      ...stringList(card.constraints),
      ...(Array.isArray(card.accepted_decisions) ? card.accepted_decisions : [])
        .map(sentence)
        .filter(
          (s: any): s is string =>
            typeof s === "string" && s.length > 0 && s.length <= 20000,
        ),
      ...(Array.isArray(card.user_corrections) ? card.user_corrections : [])
        .map(sentence)
        .filter(
          (s: any): s is string =>
            typeof s === "string" && s.length > 0 && s.length <= 20000,
        ),
    ]);
    if (constraints.length && existing.constraints === undefined)
      patch.constraints = constraints;
    const explicitKeys = stringList(card.depends_on);
    const dependencies = unique(
      explicitKeys.flatMap((key) =>
        keys.get(key)?.length === 1 ? keys.get(key)! : [],
      ),
    );
    if (
      explicitKeys.length &&
      dependencies.length === explicitKeys.length &&
      !dependencies.includes(x.work) &&
      existing.depends_on === undefined &&
      (existing.dependency_mode === undefined ||
        existing.dependency_mode === "list")
    ) {
      patch.depends_on = dependencies;
      if (existing.dependency_mode === undefined)
        patch.dependency_mode = "list";
    }
    const attributes = await writeTaskAttributes(
      c,
      owner,
      x.work,
      definitions,
      patch,
      "ui",
    );
    await c.query(
      "INSERT INTO entity_attribute_imports(owner_id,entity_type,entity_id,source_artifact_id,source_version_id,imported_codes) VALUES($1,'task',$2,$3,$4,$5)",
      [owner, x.work, x.artifact, x.version, Object.keys(patch)],
    );
    if (Object.keys(patch).length) {
      await c.query(
        "UPDATE work_items SET revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
        [owner, x.work],
      );
      await c.query(
        "INSERT INTO audit_events(owner_id,actor,kind,target_id,details) VALUES($1,'system','task_context_attributes_import',$2,$3)",
        [
          owner,
          x.work,
          JSON.stringify({
            source_artifact_id: x.artifact,
            source_version_id: x.version,
            imported_codes: Object.keys(patch),
            attributes,
          }),
        ],
      );
      await c.query(
        "UPDATE workspaces SET revision=revision+1,updated_at=now() WHERE owner_id=$1",
        [owner],
      );
    }
  }
}
