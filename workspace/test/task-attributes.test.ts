import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";
import { DomainError, hash, id } from "../src/db.js";
import { readyAttributes } from "./task-attributes-fixtures.js";

const err = (code: string) => (e: any) =>
  e instanceof DomainError && e.code === code;
test("typed constructor, lifecycle gates, owner scope, immutable context and one-time backfill", async (t) => {
  const h = await harness();
  const mut = (body: any) => ({ operation_id: id(), ...body });
  try {
    const p = await h.call(
      "project_create",
      mut({ title: "TEST task constructor" }),
    );
    const create = (title: string) =>
      h.call("work_item_create", mut({ project_id: p.id, title }));
    const get = (work: any) => h.call("work_item_get", { id: work.id });
    const patch = async (work: any, attributes: any, actor = h.ui) =>
      h.call(
        "work_item_attributes_update",
        mut({
          id: work.id,
          expected_revision: Number((await get(work)).revision),
          attributes,
          reason: "TEST: explicit attributes",
        }),
        actor,
      );
    await t.test(
      "draft/readiness, CAS replay, active and completion cannot bypass required values",
      async () => {
        const w = await create("Lifecycle");
        assert.equal(w.status, "planned");
        assert.equal(w.readiness.ready, false);
        await assert.rejects(
          h.call(
            "work_item_update",
            mut({
              id: w.id,
              expected_revision: 1,
              status: "active",
              reason: "TEST",
            }),
          ),
          err("task_attributes_required"),
        );
        const request = mut({
          id: w.id,
          expected_revision: 1,
          attributes: readyAttributes,
          reason: "TEST",
        });
        const filled = await h.call("work_item_attributes_update", request);
        assert.equal(
          Number(
            (await h.call("work_item_attributes_update", request)).revision,
          ),
          Number(filled.revision),
        );
        await assert.rejects(
          h.call("work_item_attributes_update", {
            ...request,
            operation_id: id(),
          }),
          err("revision_conflict"),
        );
        const active = await h.call(
          "work_item_update",
          mut({
            id: w.id,
            expected_revision: Number(filled.revision),
            status: "active",
            reason: "TEST",
          }),
        );
        await assert.rejects(
          patch(w, { accountable: null }),
          err("task_attributes_required"),
        );
        assert.equal(Number((await get(w)).revision), Number(active.revision));
        await assert.rejects(
          patch(
            w,
            { verification_state: "accepted", verified_by: "TEST" },
            h.model,
          ),
          err("human_ui_required"),
        );
        await assert.rejects(
          h.call(
            "work_item_complete",
            mut({
              id: w.id,
              expected_revision: Number(active.revision),
              reason: "TEST",
              evidence: [],
              manual_assessment: true,
            }),
          ),
          err("task_attributes_required"),
        );
        const performed = await patch(w, {
          execution_state: "executed",
          result_refs: ["test://result"],
          verification_state: "accepted",
          verified_by: "TEST verifier",
          verification_evidence: ["test://proof"],
        });
        const completed = await h.call(
          "work_item_complete",
          mut({
            id: w.id,
            expected_revision: Number(performed.revision),
            reason: "TEST",
            evidence: [
              {
                check: "TEST criterion",
                outcome: "pass",
                reference: "test://proof",
              },
            ],
          }),
        );
        assert.equal(completed.status, "completed");
        await assert.rejects(
          patch(w, { acceptance_criteria: ["Changed criterion"] }),
          err("task_attributes_required"),
        );
        await h.call(
          "work_item_update",
          mut({
            id: w.id,
            expected_revision: Number(completed.revision),
            status: "planned",
            reason: "TEST explicit reopen",
          }),
        );
        const changed = await patch(w, {
          acceptance_criteria: ["Changed criterion"],
        });
        assert.equal(changed.attributes.verification_state, "not_checked");
        assert.equal(changed.attributes.verified_by, undefined);
        assert.equal(changed.attributes.verification_evidence, undefined);
      },
    );
    await t.test(
      "dependencies reject self, cycles and cross-owner references; values are typed in SQL",
      async () => {
        const a = await create("A"),
          b = await create("B");
        await assert.rejects(
          patch(a, { dependency_mode: "list", depends_on: [a.id] }),
          err("task_dependency_self"),
        );
        await patch(a, { dependency_mode: "list", depends_on: [b.id] });
        await assert.rejects(
          patch(b, { dependency_mode: "list", depends_on: [a.id] }),
          err("task_dependency_cycle"),
        );
        const other = { ...h.ui, owner_id: id() };
        await h.service.init(other.owner_id);
        const op = await h.call(
          "project_create",
          mut({ title: "Other owner" }),
          other,
        );
        const ow = await h.call(
          "work_item_create",
          mut({ project_id: op.id, title: "Other owner task" }),
          other,
        );
        await assert.rejects(
          patch(a, { depends_on: [ow.id] }),
          err("not_found"),
        );
        const parameter = (await h.call("task_parameter_list")).find(
          (d: any) => d.code === "budget",
        );
        await assert.rejects(
          h.db.tx(h.owner, (c) =>
            c.query(
              "INSERT INTO entity_parameter_values(owner_id,entity_type,entity_id,parameter_id,data_type,multiple,ordinal,value_text) VALUES($1,'task',$2,$3,'number',false,0,'wrong')",
              [h.owner, a.id, parameter.id],
            ),
          ),
          (e: any) => e.code === "23514",
        );
        await h.call(
          "task_parameter_define",
          mut({
            code: "venue_capacity",
            label: "Вместимость",
            data_type: "number",
          }),
        );
        assert.equal(
          (await patch(a, { venue_capacity: 16 })).attributes.venue_capacity,
          16,
        );
      },
    );
    await t.test(
      "execution includes attrs and rejects old snapshots after task or metadata changes",
      async () => {
        const w = await create("Snapshot"),
          snapshot = () =>
            h.call(
              "context_prepare",
              mut({
                work_item_id: w.id,
                contract_revision: "TEST",
                requested_action: "execution",
                executor_id: "desktop",
                input_refs: [],
                skill_versions: [],
                requirements: [],
              }),
            );
        const incomplete = await snapshot();
        await assert.rejects(
          h.call(
            "run_create",
            mut({
              snapshot_id: incomplete.id,
              executor_id: "desktop",
              kind: "execution",
              trigger: "manual",
            }),
          ),
          err("preflight_blocked"),
        );
        await patch(w, readyAttributes);
        const s = await snapshot();
        assert.equal(s.preflight.available, true);
        assert.equal(
          s.body.attributes.expected_result,
          readyAttributes.expected_result,
        );
        const original = hash(s.body);
        await patch(w, { next_action: "TEST changed next action" });
        await assert.rejects(
          h.call(
            "run_create",
            mut({
              snapshot_id: s.id,
              executor_id: "desktop",
              kind: "execution",
              trigger: "manual",
            }),
          ),
          err("preflight_blocked"),
        );
        assert.equal(
          hash((await h.call("context_get", { id: s.id })).body),
          original,
        );
        const current = await snapshot();
        await h.call(
          "task_parameter_define",
          mut({
            code: "custom_required",
            label: "TEST required",
            data_type: "string",
            required_stage: "activation",
          }),
        );
        await assert.rejects(
          h.call(
            "run_create",
            mut({
              snapshot_id: current.id,
              executor_id: "desktop",
              kind: "execution",
              trigger: "manual",
            }),
          ),
          err("preflight_blocked"),
        );
        const definition = (await h.call("task_parameter_list")).find(
          (d: any) => d.code === "custom_required",
        );
        await h.call(
          "task_parameter_define",
          mut({
            code: "custom_required",
            label: "TEST required",
            data_type: "string",
            expected_revision: Number(definition.revision),
            required_stage: "none",
          }),
        );
      },
    );
    await t.test(
      "metadata cannot invalidate an active task and enum options cannot strand stored values",
      async () => {
        const w = await create("Metadata guard");
        const ready = await patch(w, readyAttributes);
        await h.call(
          "work_item_update",
          mut({
            id: w.id,
            expected_revision: Number(ready.revision),
            status: "active",
            reason: "TEST",
          }),
        );
        const d = await h.call(
          "task_parameter_define",
          mut({
            code: "optional_note",
            label: "TEST note",
            data_type: "string",
          }),
        );
        await assert.rejects(
          h.call(
            "task_parameter_define",
            mut({
              code: "optional_note",
              label: "TEST note",
              data_type: "string",
              expected_revision: Number(d.revision),
              required_stage: "activation",
            }),
          ),
          err("parameter_change_invalidates_task"),
        );
        assert.equal(
          (await h.call("task_parameter_list")).find(
            (x: any) => x.code === "optional_note",
          ).required_stage,
          "none",
        );
        await patch(w, { optional_note: "TEST value" });
        const required = await h.call(
          "task_parameter_define",
          mut({
            code: "optional_note",
            label: "TEST note",
            data_type: "string",
            expected_revision: Number(d.revision),
            required_stage: "activation",
          }),
        );
        assert.equal(required.required_stage, "activation");
        await h.call(
          "work_item_update",
          mut({
            id: w.id,
            expected_revision: Number((await get(w)).revision),
            status: "planned",
            reason: "TEST deactivate fixture",
          }),
        );
      },
    );
    await t.test(
      "artifact backfill preserves facts and manual values, ignores dates and related_tasks, runs once",
      async () => {
        const a = await create("Import A"),
          b = await create("Import B");
        const source = (work: any, key: string, extras: any = {}) =>
          h.call(
            "artifact_add",
            mut({
              work_item_id: work.id,
              title: "TEST context",
              kind: "text",
              content: JSON.stringify({
                schema: "ycs-task-context/1",
                card: {
                  key,
                  goal: "TEST original goal",
                  next_step: "TEST next action",
                  source_refs: ["test://source"],
                  accepted_decisions: [
                    {
                      text: "TEST сохранить это",
                      source_refs: ["test://decision"],
                    },
                  ],
                  user_corrections: [{ text: "TEST поправка" }],
                  summary: "Матч 09.10.2026 в 20:30 МСК; стоимость 250000",
                  status: "completed_reported",
                  ...extras,
                },
              }),
            }),
          );
        await patch(a, { expected_result: "TEST manually approved result" });
        await source(a, "import-a", { related_tasks: ["import-b"] });
        await source(b, "import-b", { depends_on: ["import-a"] });
        await h.service.init(h.owner);
        const ga = await get(a),
          gb = await get(b);
        assert.equal(
          ga.attributes.expected_result,
          "TEST manually approved result",
        );
        assert.equal(ga.attributes.next_action, "TEST next action");
        assert.equal(ga.attributes.due_at, undefined);
        assert.equal(ga.attributes.budget, undefined);
        assert.equal(ga.attributes.task_type, undefined);
        assert.equal(ga.attributes.depends_on, undefined);
        assert.deepEqual(gb.attributes.depends_on, [a.id]);
        assert.deepEqual(ga.attributes.constraints, [
          "TEST сохранить это",
          "TEST поправка",
        ]);
        assert.equal(ga.readiness.ready, false);
        await patch(a, { next_action: null });
        const revision = Number((await get(a)).revision);
        await h.service.init(h.owner);
        assert.equal((await get(a)).attributes.next_action, undefined);
        assert.equal(Number((await get(a)).revision), revision);
        const exportData = (await h.call("workspace_export")).data;
        assert.equal(exportData.entity_attribute_imports.length, 2);
        assert.ok(exportData.entity_parameter_values.length > 0);
      },
    );
  } finally {
    await h.close();
  }
});
