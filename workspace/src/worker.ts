import { id, DomainError, one } from "./db.js";
import type { WorkspaceService, Actor } from "./service.js";
import type { AgentsAdapter } from "./adapter-contract.js";
import { nextSlot } from "./schedule.js";
export type AdapterFactory = (
  run: any,
  snapshot: any,
) => AgentsAdapter | Promise<AgentsAdapter>;
const done = new Set(["succeeded", "failed", "cancelled"]);
export class Worker {
  readonly instance = id();
  constructor(
    private service: WorkspaceService,
    private owner: string,
    private factory: AdapterFactory,
  ) {}
  async schedulerTick(now = new Date(), recovering = false) {
    const s = this.service;
    return s.db.tx(this.owner, async (c) => {
      const due = (
        await c.query(
          "SELECT * FROM recurring_jobs WHERE owner_id=$1 AND status='active' AND NOT reference_only AND next_planned_at<=$2 ORDER BY next_planned_at,id",
          [this.owner, now],
        )
      ).rows;
      for (const j of due) {
        let slot = {
          at: new Date(j.next_planned_at),
          skipped_dst: j.next_skipped_dst,
        };
        // Catch up metadata only; never dispatch missed work after downtime.
        for (let count = 0; slot.at <= now && count < 1000; count++) {
          const existing = await c.query(
            "SELECT id FROM occurrences WHERE job_id=$1 AND schedule_revision=$2 AND planned_at_utc=$3",
            [j.id, j.schedule_revision, slot.at],
          );
          if (!existing.rowCount) {
            const w = await s.row(c, "work_items", this.owner, j.work_item_id);
            let outcome = slot.skipped_dst
              ? "skipped_dst"
              : (recovering && slot.at < now) ||
                  slot.at.getTime() < now.getTime() - 10000
                ? "skipped_downtime"
                : "enqueued";
            let run: any = null;
            let reason = "";
            if (outcome === "enqueued") {
              const overlap = await c.query(
                "SELECT r.id FROM runs r JOIN occurrences o ON o.run_id=r.id AND o.owner_id=r.owner_id WHERE o.job_id=$1 AND r.status NOT IN ('succeeded','failed','cancelled')",
                [j.id],
              );
              if (overlap.rowCount) outcome = "skipped_overlap";
              else {
                try {
                  const snapshot = await s.makeSnapshot(
                    c,
                    {
                      ...j.configuration,
                      work_item_id: j.work_item_id,
                      contract_revision: "routine:" + j.instruction_revision,
                      requested_action: "execution",
                      executor_id: j.executor_id,
                      instruction: j.instruction,
                    },
                    this.actor(),
                  );
                  run = await s.enqueue(
                    c,
                    snapshot,
                    "execution",
                    j.executor_id,
                    "schedule",
                    this.owner,
                  );
                } catch (e) {
                  if (!(e instanceof DomainError)) throw e;
                  outcome = "blocked";
                  reason = e.code;
                  await c.query(
                    "UPDATE recurring_jobs SET status='blocked',revision=revision+1,updated_at=now() WHERE id=$1",
                    [j.id],
                  );
                }
              }
            }
            const occurrence = id();
            await c.query(
              "INSERT INTO occurrences(id,owner_id,job_id,schedule_revision,planned_at_utc,outcome,run_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
              [
                occurrence,
                this.owner,
                j.id,
                j.schedule_revision,
                slot.at,
                outcome,
                run?.id ?? null,
              ],
            );
            if (outcome !== "enqueued")
              await s.event(c, this.owner, {
                project_id: w.project_id,
                work_item_id: w.id,
                source: "occurrence",
                source_event_id: occurrence,
                type: "obstacle",
                reason: `Расписание: ${outcome}${reason ? "; " + reason : ""}`,
                refs: [occurrence],
              });
            await s.audit(c, this.actor(), "schedule_occurrence", j.id, {
              occurrence_id: occurrence,
              outcome,
              planned_at_utc: slot.at.toISOString(),
            });
          }
          slot = nextSlot(j.schedule, j.timezone, slot.at);
        }
        // A very long downtime is represented without dispatching an unbounded backlog.
        if (slot.at <= now) {
          await s.event(c, this.owner, {
            project_id: (
              await s.row(c, "work_items", this.owner, j.work_item_id)
            ).project_id,
            work_item_id: j.work_item_id,
            source: "scheduler",
            source_event_id:
              j.id + ":" + j.schedule_revision + ":" + now.toISOString(),
            type: "obstacle",
            reason:
              "Длительный простой: оставшиеся слоты не запущены; требуется сверка расписания",
            refs: [j.id],
          });
          slot = nextSlot(j.schedule, j.timezone, now);
        }
        await c.query(
          "UPDATE recurring_jobs SET next_planned_at=$3,next_skipped_dst=$4 WHERE owner_id=$1 AND id=$2",
          [this.owner, j.id, slot.at, slot.skipped_dst],
        );
      }
      return due.length;
    });
  }
  private actor(run?: any): Actor {
    return {
      owner_id: this.owner,
      channel: "worker",
      executor_id: "worker",
      ...(run
        ? {
            run_id: run.id,
            attempt_id: run.attempt_id,
            claimant_id: this.instance,
          }
        : {}),
    };
  }
  async poll() {
    const s = this.service;
    const rows = (
      await s.db.pool.query(
        "SELECT * FROM runs WHERE owner_id=$1 AND executor_id='worker' AND status NOT IN ('succeeded','failed','cancelled') ORDER BY created_at,id",
        [this.owner],
      )
    ).rows;
    for (const original of rows) {
      let run = original;
      if (run.cancellation_requested_at && !run.attempt_id) {
        await s.db.tx(this.owner, async (c) => {
          const r = await s.row(c, "runs", this.owner, run.id);
          if (!done.has(r.status) && !r.attempt_id)
            await c.query(
              "UPDATE runs SET status='cancelled',revision=revision+1,updated_at=now() WHERE id=$1",
              [r.id],
            );
        });
        continue;
      }
      if (!run.attempt_id) {
        try {
          run = (
            await s.execute(
              "claim_run",
              {
                operation_id: id(),
                id: run.id,
                expected_revision: Number(run.revision),
                claimant_id: this.instance,
              },
              this.actor(),
            )
          ).data;
        } catch (e) {
          if (e instanceof DomainError) continue;
          throw e;
        }
      }
      // A second worker may only recover an expired lease; the same attempt is preserved.
      const owned = await s.db.tx(this.owner, async (c) => {
        const r = await s.row(c, "runs", this.owner, run.id);
        if (done.has(r.status)) return null;
        if (
          r.attempt_executor !== "worker:" + this.instance &&
          r.lease_until &&
          new Date(r.lease_until) > new Date()
        )
          return null;
        return one(
          c,
          "UPDATE runs SET attempt_executor=$3,lease_until=now()+interval '2 minutes' WHERE owner_id=$1 AND id=$2 RETURNING *",
          [this.owner, r.id, "worker:" + this.instance],
        );
      });
      if (!owned) continue;
      run = owned;
      const snapshot = (
        await s.execute("context_get", { id: run.snapshot_id }, this.actor(run))
      ).data;
      const adapter = await this.factory(run, snapshot.body);
      if (!run.provider_session_ref) {
        if (run.dispatch_intent_at) {
          await this.unknown(
            run,
            "Исход создания provider session неизвестен; повтор запрещён",
          );
          continue;
        }
        if (run.cancellation_requested_at) {
          await this.finish(run, "cancelled");
          continue;
        }
        const intent = await s.db.tx(this.owner, async (c) => {
          const r = await s.row(c, "runs", this.owner, run.id);
          if (
            !this.owns(r) ||
            r.cancellation_requested_at ||
            r.dispatch_intent_at ||
            done.has(r.status)
          )
            return false;
          await c.query(
            "UPDATE runs SET dispatch_intent_at=now(),revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
            [this.owner, r.id],
          );
          return true;
        });
        if (!intent) continue;
        try {
          const created = await adapter.create({
            run_id: run.id,
            snapshot: snapshot.body,
            instruction: snapshot.body.instruction ?? snapshot.body.goal,
            trusted_instructions: this.trustedInstructions(
              snapshot.body.packages,
            ),
          });
          await s.db.tx(this.owner, async (c) => {
            const r = await s.row(c, "runs", this.owner, run.id);
            if (
              r.attempt_id === run.attempt_id &&
              !r.provider_session_ref &&
              !done.has(r.status)
            )
              await c.query(
                "UPDATE runs SET provider_session_ref=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
                [this.owner, r.id, created.id],
              );
          });
        } catch (e) {
          if ((e as any)?.unknownOutcome === false)
            await this.finish(run, "failed");
          else
            await this.unknown(
              run,
              "Исход создания provider session неизвестен; повтор запрещён",
            );
        }
        continue;
      }
      const state = await adapter.retrieve(run.provider_session_ref);
      await s.db.pool.query(
        "UPDATE webhook_events SET processed_at=now() WHERE owner_id=$1 AND session_id=$2 AND processed_at IS NULL",
        [this.owner, run.provider_session_ref],
      );
      run = (
        await s.db.pool.query(
          "SELECT * FROM runs WHERE owner_id=$1 AND id=$2",
          [this.owner, run.id],
        )
      ).rows[0];
      if (!this.owns(run) || done.has(run.status)) continue;
      if (run.cancellation_requested_at) {
        if (state.state === "cancelled" || state.state === "failed") {
          await this.finish(run, "cancelled");
          continue;
        }
        if (state.state === "succeeded" && state.result) {
          await s.execute(
            "save_run_result",
            {
              operation_id: id(),
              id: run.id,
              attempt_id: run.attempt_id,
              body: {
                ...state.result,
                input_refs: snapshot.body.input_refs,
                artifact_refs: [],
              },
            },
            this.actor(run),
          );
          await this.finish(run, "cancelled");
          continue;
        }
        if (!run.cancel_dispatched_at) {
          await s.db.tx(this.owner, async (c) => {
            const r = await s.row(c, "runs", this.owner, run.id);
            if (!this.owns(r) || done.has(r.status))
              throw new DomainError("attempt_fenced", 409);
            await c.query(
              "UPDATE runs SET cancel_dispatched_at=now() WHERE owner_id=$1 AND id=$2 AND cancel_dispatched_at IS NULL",
              [this.owner, run.id],
            );
          });
          try {
            await adapter.cancel(run.provider_session_ref);
          } catch {
            await this.unknown(
              run,
              "Отмена отправлена, исход неизвестен; ожидается сверка provider",
            );
          }
        }
        continue;
      }
      const pending = (
        await s.db.pool.query(
          "SELECT * FROM provider_inputs WHERE owner_id=$1 AND run_id=$2 AND status<>'reconciled' ORDER BY created_at DESC LIMIT 1",
          [this.owner, run.id],
        )
      ).rows[0];
      if (pending) {
        if (state.turn_id && state.turn_id !== pending.baseline_turn_id) {
          await s.db.tx(this.owner, async (c) => {
            const r = await s.row(c, "runs", this.owner, run.id);
            if (this.owns(r))
              await c.query(
                "UPDATE provider_inputs SET status='reconciled' WHERE id=$1",
                [pending.id],
              );
          });
        } else {
          if (!pending.dispatch_intent_at && adapter.respond) {
            const dispatch = await s.db.tx(this.owner, async (c) => {
              const r = await s.row(c, "runs", this.owner, run.id);
              if (
                !this.owns(r) ||
                r.cancellation_requested_at ||
                done.has(r.status)
              )
                return false;
              const q = await c.query(
                "UPDATE provider_inputs SET dispatch_intent_at=now() WHERE id=$1 AND dispatch_intent_at IS NULL RETURNING id",
                [pending.id],
              );
              return !!q.rowCount;
            });
            if (dispatch) {
              try {
                await adapter.respond(
                  run.provider_session_ref,
                  pending.answer,
                  pending.id,
                );
                await s.db.pool.query(
                  "UPDATE provider_inputs SET status='accepted' WHERE id=$1",
                  [pending.id],
                );
              } catch {
                await s.db.pool.query(
                  "UPDATE provider_inputs SET status='unknown' WHERE id=$1",
                  [pending.id],
                );
                await this.unknown(
                  run,
                  "Исход отправки ответа неизвестен; повтор не выполнен, ожидается новый provider turn",
                );
              }
            }
          }
          // HTTP acceptance is not a new turn. Never reuse the preceding saved result.
          continue;
        }
      }
      await s.db.tx(this.owner, async (c) => {
        const r = await s.row(c, "runs", this.owner, run.id);
        if (this.owns(r) && !done.has(r.status))
          await c.query(
            "UPDATE runs SET provider_turn_id=$3,provider_wait_reason=$4 WHERE owner_id=$1 AND id=$2",
            [this.owner, run.id, state.turn_id ?? null, state.reason ?? null],
          );
      });
      if (state.state === "succeeded" && state.result) {
        await s.execute(
          "save_run_result",
          {
            operation_id: id(),
            id: run.id,
            attempt_id: run.attempt_id,
            body: {
              ...state.result,
              input_refs: snapshot.body.input_refs,
              artifact_refs: [],
            },
          },
          this.actor(run),
        );
      } else if (state.state === "failed") await this.finish(run, "failed");
      else if (state.state === "cancelled") await this.finish(run, "failed");
      else if (state.state === "unknown")
        await this.unknown(run, state.reason ?? "Provider state неизвестен");
      else if (state.state === "waiting_user")
        await this.finish(run, "waiting_user");
      else if (state.state === "running" && run.status === "unknown")
        await this.finish(run, "running");
    }
  }
  private owns(run: any) {
    return run.attempt_executor === "worker:" + this.instance;
  }
  private trustedInstructions(packages: any[]) {
    return [...packages]
      .sort((a, b) => {
        const rank = (name: string) =>
          name === "loki" ? 0 : name === "run-roman-control-loop" ? 1 : 2;
        return rank(a.name) - rank(b.name);
      })
      .filter((p) => p.origin === "owned")
      .map(
        (p) =>
          `\nSkill ${p.name} / ${p.version} / ${p.digest}\n` +
          p.manifest
            .filter((f: any) => f.path.endsWith(".md"))
            .sort((a: any, b: any) =>
              a.path === "SKILL.md"
                ? -1
                : b.path === "SKILL.md"
                  ? 1
                  : a.path.localeCompare(b.path),
            )
            .map(
              (f: any) =>
                `\nResource ${f.path}\n` +
                Buffer.from(f.base64, "base64").toString("utf8"),
            )
            .join("\n"),
      )
      .join("\n");
  }
  private async unknown(run: any, reason: string) {
    await this.service.db.tx(this.owner, async (c) => {
      const r = await this.service.row(c, "runs", this.owner, run.id);
      if (!this.owns(r) || done.has(r.status)) return;
      await c.query(
        "UPDATE runs SET status='unknown',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
        [this.owner, r.id],
      );
      await this.service.event(c, this.owner, {
        project_id: r.project_id,
        work_item_id: r.work_item_id,
        source: "run",
        source_event_id: r.id + ":unknown",
        type: "obstacle",
        reason,
        refs: [r.id],
      });
    });
  }
  private async finish(run: any, status: string) {
    await this.service.db.tx(this.owner, async (c) => {
      const r = await this.service.row(c, "runs", this.owner, run.id);
      if (!this.owns(r) || done.has(r.status)) return;
      if (r.cancellation_requested_at && status !== "cancelled") return;
      if (!r.cancellation_requested_at && status === "cancelled")
        throw new DomainError("cancel_evidence_required");
      await c.query(
        "UPDATE runs SET status=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
        [this.owner, r.id, status],
      );
      if (status === "waiting_user" || status === "failed")
        await this.service.event(c, this.owner, {
          project_id: r.project_id,
          work_item_id: r.work_item_id,
          source: "run",
          source_event_id: r.id + ":" + status,
          type: status === "waiting_user" ? "decision_required" : "obstacle",
          reason:
            status === "waiting_user"
              ? "Provider запросил решение. Требуется явное продолжение в поддерживаемом adapter."
              : "Provider завершился ошибкой",
          refs: [r.id],
        });
    });
  }
}
