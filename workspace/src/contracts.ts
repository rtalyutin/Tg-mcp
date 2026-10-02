import { z } from "zod";
const uuid = z.string().uuid(),
  str = z.string().min(1).max(2000),
  text = z.string().max(200000);
const expected = z.number().int().positive();
const mutation = { operation_id: uuid };
const attributeValue = z.union([
  z.string().max(20000),
  z.number().finite(),
  z.boolean(),
]);
const attributePatch = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
    z.union([attributeValue, z.array(attributeValue).max(100), z.null()]),
  )
  .refine(
    (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 100,
    "Provide 1 to 100 attributes",
  );
const origin = z.enum(["owned", "platform", "third_party"]);
export const scheduleSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("daily"),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("weekly"),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    })
    .strict(),
  z
    .object({
      type: z.literal("interval"),
      minutes: z.number().int().min(1),
      anchor_at_utc: z.string().datetime(),
    })
    .strict(),
]);
const inputs = z
  .array(z.object({ artifact_id: uuid, version_id: uuid }).strict())
  .max(100);
const skills = z
  .array(z.object({ skill_id: uuid, version_id: uuid }).strict())
  .max(100);
const requirements = z
  .array(
    z.object({ connector_id: uuid, capability: str, action: str }).strict(),
  )
  .max(100);
const evidence = z
  .array(
    z
      .object({
        check: str,
        outcome: str,
        reference: z.string().max(2000).optional(),
      })
      .strict(),
  )
  .max(100);
const artifactBody = {
  content: text.optional(),
  base64: z.string().max(12000000).optional(),
  external_ref: z.string().url().max(2000).optional(),
  observed_revision: z.string().max(2000).optional(),
};
const proposalBody = z
  .object({
    statement: text,
    scope: text.optional(),
    basis: z.array(str).max(100).default([]),
    latest_result_ref: uuid.optional(),
    open_question: text.optional(),
    proposed_next_action: text.optional(),
    actions: z.array(str).max(100).optional(),
    resources: z.array(str).max(100).optional(),
  })
  .strict();
const budget = z
  .object({
    amount: z.number().positive(),
    currency: z.enum(["USD", "RUB", "EUR"]),
    mode: z.literal("soft"),
    period: z.enum(["day", "month", "run"]),
  })
  .strict();
const jobConfig = z
  .object({
    input_refs: inputs.default([]),
    skill_versions: skills.default([]),
    requirements: requirements.default([]),
    authorization_refs: z.array(uuid).max(100).default([]),
    budget: budget.optional(),
    model: str.optional(),
  })
  .strict();
export const schemas = {
  workspace_get: z.object({}).strict(),
  project_get: z.object({ id: uuid }).strict(),
  work_item_get: z.object({ id: uuid }).strict(),
  work_item_attributes_get: z.object({ id: uuid }).strict(),
  task_parameter_list: z.object({}).strict(),
  task_parameter_define: z
    .object({
      ...mutation,
      code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
      expected_revision: expected.optional(),
      label: str,
      data_type: z.enum([
        "string",
        "number",
        "boolean",
        "datetime",
        "reference",
      ]),
      multiple: z.boolean().default(false),
      options: z.array(z.string().min(1).max(200)).max(100).default([]),
      required_stage: z
        .enum(["none", "activation", "blocked", "completion"])
        .default("none"),
      type_profile: z.string().min(1).max(200).nullable().default(null),
      required_when_code: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,79}$/)
        .nullable()
        .default(null),
      required_when_value: z.string().min(1).max(200).nullable().default(null),
      protected: z.boolean().default(false),
    })
    .strict(),
  work_item_attributes_update: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      attributes: attributePatch,
      reason: str,
    })
    .strict(),
  search: z
    .object({
      q: z.string().min(1).max(300),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  history_get: z
    .object({
      after: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    })
    .strict(),
  operation_status_get: z.object({ operation_id: uuid }).strict(),
  project_create: z
    .object({
      ...mutation,
      title: str,
      parent_id: uuid.nullable().default(null),
    })
    .strict(),
  project_update: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      title: str.optional(),
      parent_id: uuid.nullable().optional(),
      current_work_item_id: uuid.nullable().optional(),
    })
    .strict(),
  project_archive: z
    .object({ ...mutation, id: uuid, expected_revision: expected, reason: str })
    .strict(),
  project_restore: z
    .object({ ...mutation, id: uuid, expected_revision: expected })
    .strict(),
  work_item_create: z
    .object({
      ...mutation,
      project_id: uuid,
      title: str,
      goal: text.default(""),
    })
    .strict(),
  work_item_update: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      title: str.optional(),
      goal: text.optional(),
      status: z.enum(["planned", "active", "blocked"]).optional(),
      reason: str,
    })
    .strict(),
  work_item_complete: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      reason: str,
      evidence,
      manual_assessment: z.boolean().default(false),
    })
    .strict(),
  work_item_archive: z
    .object({ ...mutation, id: uuid, expected_revision: expected, reason: str })
    .strict(),
  work_item_restore: z
    .object({ ...mutation, id: uuid, expected_revision: expected })
    .strict(),
  artifact_add: z
    .object({
      ...mutation,
      work_item_id: uuid,
      title: str,
      kind: z.enum(["text", "file", "external"]),
      ...artifactBody,
    })
    .strict(),
  artifact_version_create: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      ...artifactBody,
    })
    .strict(),
  artifact_link: z
    .object({ ...mutation, id: uuid, work_item_id: uuid })
    .strict(),
  artifact_get: z.object({ id: uuid, version_id: uuid.optional() }).strict(),
  proposal_record: z
    .object({
      ...mutation,
      project_id: uuid,
      work_item_id: uuid.optional(),
      kind: z.enum(["decision", "continuation", "permission"]),
      body: proposalBody,
    })
    .strict(),
  proposal_accept: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      content_hash: z.string().length(64),
    })
    .strict(),
  proposal_revoke: z
    .object({ ...mutation, id: uuid, expected_revision: expected, reason: str })
    .strict(),
  context_prepare: z
    .object({
      ...mutation,
      work_item_id: uuid,
      contract_revision: str,
      requested_action: z.enum(["discussion", "execution"]),
      executor_id: str,
      input_refs: inputs,
      skill_versions: skills,
      requirements,
      authorization_refs: z.array(uuid).max(100).default([]),
      model: str.optional(),
      budget: budget.optional(),
    })
    .strict(),
  context_get: z.object({ id: uuid }).strict(),
  run_create: z
    .object({
      ...mutation,
      snapshot_id: uuid,
      kind: z.enum(["discussion", "execution"]),
      executor_id: str,
      trigger: z.enum(["interactive", "manual"]),
      parent_run_id: uuid.optional(),
    })
    .strict(),
  run_get: z.object({ id: uuid }).strict(),
  claim_run: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      claimant_id: uuid,
    })
    .strict(),
  save_run_result: z
    .object({
      ...mutation,
      id: uuid,
      attempt_id: uuid,
      body: z
        .object({
          text,
          artifact_refs: z.array(uuid).max(100).default([]),
          input_refs: inputs,
          evidence_status: z.enum([
            "PREPARED",
            "EXECUTED",
            "VERIFIED",
            "STALE",
          ]),
          evidence,
          limitations: z.array(str).max(100).default([]),
        })
        .strict(),
    })
    .strict(),
  run_transition: z
    .object({
      ...mutation,
      id: uuid,
      attempt_id: uuid,
      expected_revision: expected,
      status: z.enum([
        "waiting_user",
        "blocked",
        "unknown",
        "failed",
        "cancelled",
      ]),
      reason: str,
    })
    .strict(),
  run_resume: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      answer: text.optional(),
    })
    .strict(),
  run_cancel: z
    .object({ ...mutation, id: uuid, expected_revision: expected })
    .strict(),
  dispatch_report: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      status: z.enum(["dispatched", "unknown"]),
      conversation_ref: z.string().url().optional(),
    })
    .strict(),
  attention_list: z
    .object({
      project_id: uuid.optional(),
      include_descendants: z.boolean().default(false),
      before_id: uuid.optional(),
      type: z
        .enum([
          "result_ready",
          "decision_required",
          "obstacle",
          "change_detected",
        ])
        .optional(),
      state: z.enum(["open", "snoozed", "resolved", "all"]).default("open"),
      before: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  request_attention: z
    .object({
      ...mutation,
      project_id: uuid,
      work_item_id: uuid.optional(),
      source: str,
      source_event_id: str,
      type: z.enum([
        "result_ready",
        "decision_required",
        "obstacle",
        "change_detected",
      ]),
      reason: str,
      refs: z.array(str).max(100).default([]),
    })
    .strict(),
  attention_update: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      action: z.enum(["read", "snooze", "resolve"]),
      snoozed_until: z.string().datetime().optional(),
      reason: str.optional(),
    })
    .strict(),
  skills_list: z.object({}).strict(),
  skill_register: z
    .object({
      ...mutation,
      id: uuid.optional(),
      expected_revision: expected.optional(),
      name: str,
      origin,
      source_ref: str,
      version: str,
      requirements,
      triggers: z.array(str).max(100),
      files: z
        .array(
          z
            .object({
              path: str,
              base64: z.string().max(12000000),
              sha256: z.string().length(64),
            })
            .strict(),
        )
        .max(500),
      digest: z.string().length(64),
    })
    .strict(),
  skill_select_version: z
    .object({
      ...mutation,
      id: uuid,
      expected_revision: expected,
      version_id: uuid,
    })
    .strict(),
  skill_package_read: z.object({ id: uuid, version_id: uuid }).strict(),
  connector_register: z
    .object({
      ...mutation,
      id: uuid.optional(),
      expected_revision: expected.optional(),
      name: str,
      origin,
      transport: z.enum(["http", "stdio", "native"]),
      location: z.enum(["remote", "desktop", "native"]),
      metadata: z
        .object({
          version: str.optional(),
          issuer: z.string().url().optional(),
          audience: str.optional(),
          identity_ref: str.optional(),
          source_ref: str.optional(),
        })
        .strict(),
    })
    .strict(),
  capability_observe: z
    .object({
      ...mutation,
      connector_id: uuid,
      executor_id: str,
      capability: str,
      configured: z.boolean(),
      reachable: z.boolean(),
      authenticated: z.boolean(),
      allowed: z.boolean(),
      actions: z.array(str).max(100),
      identity_ref: str.optional(),
      observed_at: z.string().datetime(),
      expires_at: z.string().datetime(),
      reason: str.optional(),
    })
    .strict(),
  capabilities_list: z.object({ executor_id: str.optional() }).strict(),
  external_mcp_read: z
    .object({ connector_id: uuid, tool_name: str, resource: str })
    .strict(),
  recurring_job_save: z
    .object({
      ...mutation,
      id: uuid.optional(),
      expected_revision: expected.optional(),
      work_item_id: uuid,
      instruction: text,
      schedule: scheduleSchema,
      timezone: str,
      executor_id: str,
      configuration: jobConfig,
      reference_only: z.boolean().default(false),
      provider_ref: str.optional(),
      replacement_ref: str.optional(),
      old_pause_status: z
        .enum(["confirmed", "unknown", "not_requested"])
        .optional(),
    })
    .strict(),
  recurring_job_activate: z
    .object({ ...mutation, id: uuid, expected_revision: expected })
    .strict(),
  recurring_job_retire: z
    .object({ ...mutation, id: uuid, expected_revision: expected })
    .strict(),
  recurring_job_pause: z
    .object({ ...mutation, id: uuid, expected_revision: expected })
    .strict(),
  recurring_jobs_list: z.object({ work_item_id: uuid.optional() }).strict(),
  workspace_export: z.object({}).strict(),
};
export type Operation = keyof typeof schemas;
export const humanOnly = new Set<Operation>([
  "task_parameter_define",
  "attention_update",
  "project_archive",
  "project_restore",
  "work_item_complete",
  "work_item_archive",
  "work_item_restore",
  "proposal_accept",
  "proposal_revoke",
  "run_resume",
  "run_cancel",
  "dispatch_report",
  "recurring_job_activate",
  "recurring_job_pause",
  "recurring_job_retire",
  "skill_register",
  "skill_select_version",
  "connector_register",
  "capability_observe",
  "recurring_job_save",
]);
export const workerAllowed = new Set<Operation>([
  "external_mcp_read",
  "context_get",
  "run_get",
  "claim_run",
  "save_run_result",
  "run_transition",
  "request_attention",
  "skill_package_read",
  "artifact_get",
  "capabilities_list",
]);
export const reads = new Set<Operation>([
  "external_mcp_read",
  "workspace_get",
  "project_get",
  "work_item_get",
  "work_item_attributes_get",
  "task_parameter_list",
  "search",
  "history_get",
  "operation_status_get",
  "artifact_get",
  "context_get",
  "run_get",
  "attention_list",
  "skills_list",
  "skill_package_read",
  "capabilities_list",
  "recurring_jobs_list",
  "workspace_export",
]);
