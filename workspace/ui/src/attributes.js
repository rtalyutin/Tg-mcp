export const verificationLabels = {
  not_checked: "Не проверено",
  accepted: "Принято",
  rejected: "Не принято",
};

const ownerFields = new Set(["verification_state", "verified_by"]);
export const ownerAttribute = (code) => ownerFields.has(code);
export const sameValue = (a, b) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const valuePresent = (value) =>
  value !== null &&
  value !== undefined &&
  (Array.isArray(value)
    ? value.length > 0
    : typeof value !== "string" || value.trim() !== "");

export function visibleDefinitions(definitions = [], values = {}) {
  return definitions.filter((definition) => {
    if (definition.type_profile && definition.type_profile !== values.task_type)
      return false;
    if (
      definition.required_when_code &&
      (definition.required_when_value === "present"
        ? !valuePresent(values[definition.required_when_code])
        : values[definition.required_when_code] !==
          definition.required_when_value)
    )
      return false;
    return true;
  });
}

export function inputValue(definition, value) {
  if (value === undefined || value === null) return "";
  if (definition.multiple)
    return (Array.isArray(value) ? value : [value]).join("\n");
  return String(value);
}

export function parseInput(definition, input) {
  if (input === "" || input.trim() === "") return null;
  const parseScalar = (raw) => {
    if (definition.data_type === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value))
        throw new Error(`${definition.label}: укажите число.`);
      return value;
    }
    if (definition.data_type === "boolean") {
      if (raw !== "true" && raw !== "false")
        throw new Error(`${definition.label}: выберите да или нет.`);
      return raw === "true";
    }
    if (
      definition.data_type === "datetime" &&
      (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ||
        !Number.isFinite(Date.parse(raw)))
    )
      throw new Error(
        `${definition.label}: укажите дату и время с часовым поясом.`,
      );
    return raw.trim();
  };
  return definition.multiple
    ? input
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(parseScalar)
    : parseScalar(input);
}

export function draftOf(definitions, attributes = {}) {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.code,
      inputValue(definition, attributes[definition.code]),
    ]),
  );
}

export function attributePatch(definitions, base, draft) {
  const changes = {};
  for (const definition of definitions) {
    const original = inputValue(definition, base[definition.code]);
    if ((draft[definition.code] ?? "") === original) continue;
    const value = parseInput(definition, draft[definition.code] ?? "");
    if (!sameValue(value, base[definition.code]))
      changes[definition.code] = value;
  }
  return changes;
}

export function rebaseDraft(definitions, base, draft, latest) {
  const next = draftOf(definitions, latest);
  const conflicts = [];
  for (const definition of definitions) {
    const code = definition.code;
    const original = inputValue(definition, base[code]);
    if ((draft[code] ?? "") !== original) {
      next[code] = draft[code];
      if (
        !sameValue(base[code], latest[code]) &&
        next[code] !== inputValue(definition, latest[code])
      )
        conflicts.push({
          code,
          label: definition.label,
          saved: inputValue(definition, latest[code]),
          draft: next[code],
        });
    }
  }
  return { draft: next, conflicts };
}

export function optionsOf(definition) {
  const labels = {
    unknown: "Не установлен",
    none: "Без срока / отсутствует",
    date: "Дата и время",
    event: "Событие",
    list: "Список",
    not_checked: "Не проверено",
    accepted: "Принято",
    rejected: "Не принято",
    development: "Разработка",
    content: "Контент",
    partnership: "Партнёрство",
    match: "Матч",
    research: "Исследование",
    organization: "Организация",
    critical: "Критический",
    high: "Высокий",
    normal: "Обычный",
    low: "Низкий",
    prepared: "Подготовлено",
    executed: "Выполнено",
  };
  return (definition.options ?? []).map((option) =>
    typeof option === "object"
      ? {
          value: String(option.value ?? option.code),
          label: option.label ?? String(option.value ?? option.code),
        }
      : {
          value: String(option),
          label:
            option === "none" && definition.code === "deadline_mode"
              ? "Без срока"
              : option === "none" && definition.code === "dependency_mode"
                ? "Зависимостей нет"
                : (labels[option] ?? String(option)),
        },
  );
}
