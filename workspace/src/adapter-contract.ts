export type ProviderState =
  "running" | "waiting_user" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface AgentResult {
  text: string;
  evidence_status: "PREPARED" | "EXECUTED" | "VERIFIED" | "STALE";
  evidence: Array<{ check: string; outcome: string; reference?: string }>;
  limitations: string[];
}
export interface AgentSessionState {
  id: string;
  /** Latest observed root turn, used to distinguish output before and after a submitted answer. */
  turn_id?: string;
  state: ProviderState;
  result?: AgentResult;
  reason?: string;
}
export interface AgentInput {
  run_id: string;
  snapshot: Record<string, unknown>;
  instruction: string;
  /** Full instructions resolved by the worker from immutable human-registered SkillVersions only. */
  trusted_instructions?: string;
}
export interface AgentsAdapter {
  create(input: AgentInput): Promise<{ id: string }>;
  retrieve(id: string): Promise<AgentSessionState>;
  cancel(id: string): Promise<void>;
  /** Submit authorized human text; acceptance alone does not establish a new turn's outcome. */
  respond?(
    sessionId: string,
    answer: string,
    idempotencyKey: string,
  ): Promise<void>;
}
