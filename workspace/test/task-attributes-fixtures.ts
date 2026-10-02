import type { Attributes } from "../src/task-attributes.js";
/** Explicit synthetic values used only by the constructor tests. */
export const readyAttributes: Attributes = {
  task_type: "organization",
  expected_result: "TEST: один проверяемый результат",
  acceptance_criteria: ["TEST: результат доступен и соответствует условию"],
  accountable: "TEST: Роман",
  next_executor: "TEST: исполнитель",
  priority: "high",
  priority_reason: "TEST: календарная зависимость",
  deadline_mode: "none",
  dependency_mode: "none",
  next_action: "TEST: сделать следующий шаг",
  source_refs: ["test://source"],
};
