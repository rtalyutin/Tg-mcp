import React, { useEffect, useRef, useState } from "react";
import {
  attributePatch,
  draftOf,
  inputValue,
  optionsOf,
  ownerAttribute,
  parseInput,
  rebaseDraft,
  verificationLabels,
  visibleDefinitions,
} from "./attributes.js";

const stages = {
  activation: "Перед запуском",
  blocked: "При блокировке",
  completion: "При завершении",
};
const knownErrors = {
  revision_conflict:
    "Карточка изменилась. Обновите версию и сверьте её с вашим черновиком.",
  stale_revision:
    "Карточка изменилась. Обновите версию и сверьте её с вашим черновиком.",
  task_attributes_required:
    "Не заполнены обязательные реквизиты. Список показан выше.",
  work_item_not_ready:
    "Не заполнены обязательные реквизиты. Список показан выше.",
  human_ui_required:
    "Подтверждение результата доступно владельцу в веб-интерфейсе.",
  validation_error:
    "Проверьте значения реквизитов. Сервер не принял изменения.",
  invalid_attribute_value:
    "Проверьте значения реквизитов. Сервер не принял изменения.",
  invalid_task_parameter_value:
    "Проверьте формат значения: дата с поясом, число или ID задачи.",
  invalid_task_timezone:
    "Укажите существующий часовой пояс, например Europe/Moscow.",
  duplicate_task_parameter_values: "В списке есть повторяющиеся значения.",
  negative_task_parameter:
    "Бюджет и трудозатраты не могут быть отрицательными.",
  task_deadline_mode_conflict:
    "Выбранный режим срока несовместим с сохранённой датой или событием.",
  task_dependency_mode_conflict:
    "Режим зависимостей несовместим с сохранённым списком задач.",
  task_dependency_self: "Задача не может зависеть от себя.",
  task_dependency_cycle: "Зависимости образуют замкнутый круг.",
  match_requires_two_teams: "Для матча укажите ровно две команды.",
  access_denied: "Нет доступа к изменению этой карточки.",
};
const definiteError = (error) =>
  Object.hasOwn(knownErrors, error?.message) ||
  /required|invalid|conflict|archived|denied|not_found/.test(
    error?.message ?? "",
  );

function AttributeInput({ definition, value, onChange, disabled, tasks }) {
  const id = `attribute-${definition.code}`;
  const options = optionsOf(definition);
  let input;
  if (definition.multiple) {
    const choices = definition.code === "depends_on" ? tasks : [];
    input = (
      <>
        {choices.length > 0 && (
          <select
            aria-label={`Добавить: ${definition.label}`}
            value=""
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value)
                onChange(
                  [...(value ? value.split("\n") : []), event.target.value]
                    .filter((x, i, a) => a.indexOf(x) === i)
                    .join("\n"),
                );
            }}
          >
            <option value="">Выбрать известную задачу…</option>
            {choices.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        )}
        <textarea
          id={id}
          value={value}
          disabled={disabled}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
          placeholder={
            definition.data_type === "reference"
              ? "ID задачи — по одному в строке"
              : "Каждый пункт с новой строки"
          }
        />
      </>
    );
  } else if (options.length > 0 || definition.data_type === "boolean") {
    const list =
      definition.data_type === "boolean"
        ? [
            { value: "true", label: "Да" },
            { value: "false", label: "Нет" },
          ]
        : options;
    input = (
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Не заполнено</option>
        {value && !list.some((option) => option.value === value) && (
          <option value={value}>{value}</option>
        )}
        {list.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (definition.data_type === "number") {
    input = (
      <input
        id={id}
        type="number"
        step="any"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else {
    input = (
      <textarea
        id={id}
        rows={definition.data_type === "datetime" ? 1 : 2}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          definition.data_type === "datetime"
            ? "2026-10-09T20:30:00+03:00"
            : "Не заполнено"
        }
      />
    );
  }
  return (
    <div className="attribute-field">
      <label htmlFor={id}>{definition.label}</label>
      {stages[definition.required_stage] && (
        <span className="attribute-stage">
          {stages[definition.required_stage]}
        </span>
      )}
      {input}
      {definition.data_type === "datetime" && (
        <small>
          Дата и время с явным часовым поясом. Часовой пояс срока задаётся
          отдельно.
        </small>
      )}
      {definition.code === "depends_on" && (
        <small>Связи сохраняются по ID задачи. Название не заменяет ID.</small>
      )}
      {definition.data_type === "reference" &&
        definition.code !== "depends_on" && (
          <small>Укажите ID связанной задачи.</small>
        )}
    </div>
  );
}

export function TaskAttributes({
  task,
  transport,
  tasks = [],
  onReload,
  onChanged,
  onPending,
}) {
  const definitions = task.attribute_definitions ?? [];
  const [base, setBase] = useState(() => ({
    revision: task.revision,
    attributes: task.attributes ?? {},
  }));
  const [draft, setDraft] = useState(() =>
    draftOf(definitions, task.attributes),
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const attempt = useRef(null);
  const dirty = definitions.some(
    (definition) =>
      (draft[definition.code] ?? "") !==
      inputValue(definition, base.attributes[definition.code]),
  );
  const stale = task.revision !== base.revision;
  useEffect(() => {
    if (!dirty && !attempt.current && !busy && stale) {
      setBase({ revision: task.revision, attributes: task.attributes ?? {} });
      setDraft(draftOf(definitions, task.attributes));
    }
  }, [task.revision, dirty, busy]);
  useEffect(() => {
    onPending?.({ dirty, busy, pending });
  }, [dirty, busy, pending]);
  const values = { ...base.attributes };
  for (const definition of definitions) {
    try {
      values[definition.code] = parseInput(
        definition,
        draft[definition.code] ?? "",
      );
    } catch {
      /* Validation happens on save. */
    }
  }
  const visible = visibleDefinitions(definitions, values);
  const missing = task.readiness?.missing ?? [];
  const conflicts = stale
    ? rebaseDraft(definitions, base.attributes, draft, task.attributes ?? {})
        .conflicts
    : [];
  const replaceBase = (value, keepDraft = false) => {
    const attributes = value.attributes ?? {};
    setDraft(
      keepDraft
        ? rebaseDraft(definitions, base.attributes, draft, attributes).draft
        : draftOf(definitions, attributes),
    );
    setBase({ revision: value.revision, attributes });
    setError(null);
  };
  const execute = async (command) => {
    attempt.current = command;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      let receipt;
      if (pending) {
        try {
          receipt = (
            await transport.read("operation_status_get", {
              operation_id: command.args.operation_id,
            })
          ).data?.result;
        } catch (lookup) {
          if (lookup.message !== "not_found") throw lookup;
        }
      }
      if (!receipt) await transport.read(command.operation, command.args);
      const verified = await onReload();
      replaceBase(verified);
      setReason("");
      setSaved(true);
      setPending(false);
      attempt.current = null;
      await Promise.resolve(onChanged()).catch(() => {});
    } catch (failure) {
      if (definiteError(failure)) {
        attempt.current = null;
        setPending(false);
        const required = failure.details?.missing
          ?.map((field) => field.label)
          .join(", ");
        setError(
          required
            ? `Нужно заполнить: ${required}.`
            : (knownErrors[failure.message] ??
                "Сервер не принял изменения. Проверьте реквизиты."),
        );
        await onReload().catch(() => {});
      } else {
        setPending(true);
        setError(
          "Сохранение не подтверждено. Черновик сохранён; повторная проверка использует тот же запрос.",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  const save = async (event) => {
    event.preventDefault();
    if (busy || (stale && !attempt.current)) return;
    if (attempt.current) return execute(attempt.current);
    let attributes;
    try {
      attributes = attributePatch(definitions, base.attributes, draft);
    } catch (error) {
      setError(error.message);
      return;
    }
    if (!Object.keys(attributes).length || !reason.trim()) return;
    return execute({
      operation: "work_item_attributes_update",
      args: {
        operation_id: crypto.randomUUID(),
        id: task.id,
        expected_revision: base.revision,
        attributes,
        reason: reason.trim(),
      },
    });
  };
  const changeStatus = (status) => {
    if (busy || pending || dirty || stale || !reason.trim()) return;
    return execute({
      operation:
        status === "completed" ? "work_item_complete" : "work_item_update",
      args: {
        operation_id: crypto.randomUUID(),
        id: task.id,
        expected_revision: base.revision,
        reason: reason.trim(),
        ...(status === "completed"
          ? { manual_assessment: true, evidence: [] }
          : { status }),
      },
    });
  };
  const stateDisabled =
    busy ||
    pending ||
    dirty ||
    stale ||
    !reason.trim() ||
    task.status === "archived";
  if (!definitions.length)
    return (
      <section className="task-attributes">
        <h3>Реквизиты задачи</h3>
        <p className="muted">
          Описание реквизитов ещё не получено. Повторите обновление карточки.
        </p>
      </section>
    );
  return (
    <section className="task-attributes" aria-labelledby="attributes-title">
      <div className="attributes-heading">
        <h3 id="attributes-title">Реквизиты задачи</h3>
        <span className="muted">Версия {task.revision}</span>
      </div>
      <div
        className={`task-readiness ${task.readiness?.ready ? "ready" : "incomplete"}`}
      >
        <strong>
          {task.readiness?.ready
            ? "Можно запускать"
            : "Карточка пока не готова к запуску"}
        </strong>
        {missing.length > 0 && (
          <>
            <p>Нужно заполнить:</p>
            <ul>
              {missing.map((field) => (
                <li key={field.code}>
                  <a href={`#attribute-${field.code}`}>{field.label}</a>
                </li>
              ))}
            </ul>
          </>
        )}
        <p>Готовность относится к сохранённой версии карточки.</p>
      </div>
      <p className="verification-summary">
        Проверка результата:{" "}
        <strong>
          {verificationLabels[task.attributes?.verification_state] ??
            "Не проверено"}
        </strong>
      </p>
      {stale && (
        <div className="error-banner" role="status">
          <p>
            Карточка обновилась. Ваш черновик сохранён. Сверьте изменившиеся
            поля перед сохранением.
          </p>
          {conflicts.length > 0 && (
            <ul className="attribute-conflicts">
              {conflicts.map((field) => (
                <li key={field.code}>
                  <strong>{field.label}</strong>
                  <p>На сервере: {field.saved || "Не заполнено"}</p>
                  <p>В черновике: {field.draft || "Не заполнено"}</p>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="soft-button"
            disabled={busy || pending}
            onClick={() => replaceBase(task, true)}
          >
            {conflicts.length
              ? "Применить мой черновик к новой версии"
              : "Продолжить с обновлённой версией"}
          </button>
          <button
            type="button"
            className="soft-button"
            disabled={busy || pending}
            onClick={() => replaceBase(task)}
          >
            Принять сохранённые значения
          </button>
        </div>
      )}
      <form onSubmit={save}>
        {task.attributes?.verification_state === "accepted" && dirty && (
          <p className="muted">
            Изменение условий или результата сбрасывает принятие: обновлённую
            версию нужно проверить снова.
          </p>
        )}
        <fieldset disabled={busy || pending || task.status === "archived"}>
          <legend className="sr-only">Значения реквизитов</legend>
          <div className="attribute-grid">
            {visible.map((definition) => (
              <AttributeInput
                key={definition.code}
                definition={definition}
                value={draft[definition.code] ?? ""}
                onChange={(value) => {
                  setDraft((old) => {
                    const next = { ...old, [definition.code]: value };
                    if (
                      ["deadline_mode", "dependency_mode"].includes(
                        definition.code,
                      )
                    ) {
                      for (const conditional of definitions)
                        if (
                          conditional.required_when_code === definition.code &&
                          conditional.required_when_value !== value
                        )
                          next[conditional.code] = "";
                    }
                    return next;
                  });
                  setSaved(false);
                }}
                disabled={
                  transport.mode === "plugin" &&
                  (definition.protected || ownerAttribute(definition.code))
                }
                tasks={tasks.filter((item) => item.id !== task.id)}
              />
            ))}
          </div>
          {transport.mode === "plugin" && (
            <p className="muted">
              Принятие результата и проверяющий задаются владельцем в
              веб-интерфейсе.
            </p>
          )}
          <label className="form-label">
            Основание изменения
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Обязательно для сохранения: что изменили"
              maxLength={2000}
            />
          </label>
        </fieldset>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="attribute-saved" role="status">
            Карточка сохранена и повторно прочитана с сервера.
          </p>
        )}
        <div className="attribute-actions">
          <span className="muted">
            {dirty
              ? "Есть несохранённые изменения"
              : "Черновик карточки можно оставить неполным"}
          </span>
          <button
            className="primary-button solid"
            disabled={busy || (!pending && (!dirty || !reason.trim() || stale))}
          >
            {busy
              ? "Сохраняем…"
              : pending
                ? "Проверить и повторить"
                : "Сохранить реквизиты"}
          </button>
        </div>
      </form>
      <div
        className="task-state-actions"
        aria-label="Изменить состояние задачи"
      >
        <h4>Состояние задачи</h4>
        <p className="muted">
          Для смены состояния сохраните реквизиты и укажите основание изменения.
        </p>
        <div className="task-state-buttons">
          {task.status !== "planned" && (
            <button
              type="button"
              className="soft-button"
              disabled={stateDisabled}
              onClick={() => changeStatus("planned")}
            >
              Запланировать
            </button>
          )}
          {task.status !== "active" && (
            <button
              type="button"
              className="soft-button"
              disabled={stateDisabled || !task.readiness?.ready}
              onClick={() => changeStatus("active")}
            >
              В работу
            </button>
          )}
          {task.status !== "blocked" && (
            <button
              type="button"
              className="soft-button"
              disabled={
                stateDisabled ||
                !task.attributes?.blocker_reason ||
                !task.attributes?.unblock_condition
              }
              onClick={() => changeStatus("blocked")}
            >
              Заблокировать
            </button>
          )}
          {transport.mode === "web" && task.status !== "completed" && (
            <button
              type="button"
              className="soft-button"
              disabled={
                stateDisabled ||
                task.attributes?.verification_state !== "accepted" ||
                task.attributes?.execution_state !== "executed"
              }
              onClick={() => changeStatus("completed")}
            >
              Завершить принятую работу
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
