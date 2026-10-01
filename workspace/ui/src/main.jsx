import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectTransport } from "./transport.js";
import {
  attentionKinds,
  taskLabels,
  runLabels,
  dateLabel,
  rootOf,
  rowStatus,
  attentionCount,
} from "./model.js";

function Icon({ name, className = "" }) {
  const paths = {
    folder: (
      <path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
    ),
    file: (
      <>
        <path d="M6 3h8l4 4v14H6Z" />
        <path d="M14 3v5h5M9 12h6M9 16h6" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6h5" />
      </>
    ),
    star: <path d="m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" />,
    search: (
      <>
        <circle cx="10" cy="10" r="7" />
        <path d="m16 16 5 5" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    plus: <path d="M12 4v16M4 12h16" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    refresh: (
      <>
        <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
      </>
    ),
    alert: (
      <>
        <path d="M12 6v7" />
        <circle cx="12" cy="18" r=".7" fill="currentColor" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    plug: (
      <>
        <path d="m9 5 3 3m3-6 3 3M7 12l5-5 5 5-5 5-5-5ZM4 21l5-5" />
      </>
    ),
    change: (
      <>
        <path d="M4 7h16M4 12h12M4 17h8" />
      </>
    ),
    dot: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  };
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.dot}
    </svg>
  );
}
function Notice({ kind, small = false }) {
  return (
    <span className={`status ${kind.tone} ${small ? "small" : ""}`}>
      <span className={`status-icon ${kind.icon !== "dot" ? "filled" : ""}`}>
        <Icon name={kind.icon} />
      </span>
      {kind.label}
    </span>
  );
}
const friendlyError = (error) =>
  ({
    auth_required: "Войдите с прежним логином, чтобы открыть проекты.",
    access_denied: "Нет доступа к этому действию.",
    unauthenticated: "Подключение не авторизовано.",
    not_found: "Объект больше не доступен. Обновите список.",
    service_unavailable: "Сервер сейчас не отвечает. Попробуйте ещё раз.",
    invalid_response: "Не удалось прочитать ответ сервера.",
  })[error?.message] ?? "Не удалось загрузить данные. Попробуйте ещё раз.";

function Dialog({ title, onClose, children, wide = false }) {
  const ref = useRef();
  useEffect(() => {
    const node = ref.current;
    node.showModal();
    return () => node.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "detail-dialog" : ""}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const box = ref.current.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            onClose();
        }
      }}
      aria-labelledby="dialog-title"
    >
      <div className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть">
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Workspace() {
  const [payload, setPayload] = useState(null),
    [error, setError] = useState(null),
    [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("active"),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(null),
    [searchError, setSearchError] = useState(null);
  const [attentionProject, setAttentionProject] = useState("all"),
    [allEvents, setAllEvents] = useState(null),
    [eventsBusy, setEventsBusy] = useState(false),
    [eventsError, setEventsError] = useState(null);
  const [detail, setDetail] = useState(null),
    [detailData, setDetailData] = useState(null),
    [detailError, setDetailError] = useState(null),
    [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState(""),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState(null);
  const transport = useRef(null),
    refreshSeq = useRef(0),
    detailSeq = useRef(0),
    eventSeq = useRef(0),
    createAttempt = useRef(null),
    loaded = useRef(false);
  const accept = (value) => {
    loaded.current = true;
    setPayload(value);
    setError(null);
  };
  const refresh = async () => {
    if (!transport.current) return;
    const seq = ++refreshSeq.current;
    setRefreshing(true);
    try {
      const value = await transport.current.read("workspace_get");
      if (seq === refreshSeq.current) {
        accept(value);
        setAllEvents(null);
      }
    } catch (e) {
      if (seq === refreshSeq.current) setError(e);
    } finally {
      if (seq === refreshSeq.current) setRefreshing(false);
    }
  };
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let mounted = true,
      channel;
    connectTransport({
      onInitial: (value) => {
        if (mounted) accept(value);
      },
      onFailure: (e) => {
        if (mounted) setError(e);
      },
    })
      .then(async (value) => {
        channel = value;
        if (!mounted) return value.close();
        transport.current = value;
        setReady(true);
        if (value.mode === "web") await refresh();
      })
      .catch((e) => {
        if (mounted) setError(e);
      });
    const timer = setTimeout(() => {
      if (mounted && !loaded.current)
        setError((e) => e ?? new Error("loading_timeout"));
    }, 20000);
    return () => {
      mounted = false;
      clearTimeout(timer);
      channel?.close();
    };
  }, []);
  useEffect(() => {
    if (payload) setError((e) => (e?.message === "loading_timeout" ? null : e));
  }, [payload]);
  useEffect(() => {
    const seq = ++eventSeq.current;
    setAllEvents(null);
    setEventsError(null);
    if (!ready || !payload || attentionProject === "all") {
      setEventsBusy(false);
      return;
    }
    setEventsBusy(true);
    transport.current
      .read("attention_list", {
        project_id: attentionProject,
        include_descendants: true,
        state: "open",
        limit: 100,
      })
      .then((result) => {
        if (seq === eventSeq.current)
          setAllEvents({
            project: attentionProject,
            items: result.data,
            exhausted: result.data.length < 100,
          });
      })
      .catch((e) => {
        if (seq === eventSeq.current) setEventsError(e);
      })
      .finally(() => {
        if (seq === eventSeq.current) setEventsBusy(false);
      });
  }, [attentionProject, payload, ready]);
  useEffect(() => {
    let current = true;
    const q = query.trim();
    setSearch(null);
    setSearchError(null);
    if (!q || !ready) return;
    const timer = setTimeout(async () => {
      try {
        const value = await transport.current.read("search", { q, limit: 30 });
        if (current) setSearch(value.data);
      } catch (e) {
        if (current) setSearchError(e);
      }
    }, 280);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, ready]);
  useEffect(() => {
    const seq = ++detailSeq.current;
    setDetailData(null);
    setDetailError(null);
    if (!detail || !transport.current) return;
    const operation =
      detail.kind === "project"
        ? "project_get"
        : detail.kind === "material"
          ? "artifact_get"
          : "work_item_get";
    const id = detail.kind === "event" ? detail.event.work_item_id : detail.id;
    if (!id) return;
    transport.current
      .read(operation, { id })
      .then((value) => {
        if (seq === detailSeq.current) setDetailData(value.data);
      })
      .catch((e) => {
        if (seq === detailSeq.current) setDetailError(e);
      });
  }, [detail]);
  const openProject = (p) =>
    setDetail({ kind: "project", id: p.id, title: p.title });
  const openSearch = (item) =>
    item.type === "project"
      ? setDetail({ kind: "project", id: item.id, title: item.title })
      : item.type === "material"
        ? setDetail({ kind: "material", id: item.id, title: item.title })
        : item.work_item_id
          ? setDetail({
              kind: "task",
              id: item.work_item_id,
              title: item.title,
            })
          : setDetail({
              kind: "project",
              id: item.project_id,
              title: item.title,
            });
  const save = async (e) => {
    e.preventDefault();
    if (!transport.current || !title.trim() || saving) return;
    const attempt = createAttempt.current ?? {
      operation_id: crypto.randomUUID(),
      title: title.trim(),
    };
    createAttempt.current = attempt;
    setSaving(true);
    setSaveError(null);
    try {
      let result;
      // Retry the same receipt after a lost response; never issue a new command ID.
      if (saveError) {
        try {
          result = (
            await transport.current.read("operation_status_get", {
              operation_id: attempt.operation_id,
            })
          ).data?.result;
        } catch (lookup) {
          if (lookup.message !== "not_found") throw lookup;
        }
      }
      if (!result) await transport.current.create(attempt);
      setCreateOpen(false);
      setTitle("");
      createAttempt.current = null;
      setFilter("active");
      setQuery("");
      await refresh();
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };
  const showAllEvents = async () => {
    if (eventsBusy) return;
    const seq = ++eventSeq.current;
    setEventsBusy(true);
    setEventsError(null);
    const items =
      allEvents?.project === attentionProject
        ? allEvents.items
        : attentionProject === "all"
          ? payload.data.attention
          : [];
    try {
      const result = await transport.current.read("attention_list", {
        ...(attentionProject === "all"
          ? {}
          : { project_id: attentionProject, include_descendants: true }),
        ...(items.length ? { before_id: items.at(-1).id } : {}),
        state: "open",
        limit: 100,
      });
      if (seq === eventSeq.current)
        setAllEvents({
          project: attentionProject,
          items: [
            ...items,
            ...result.data.filter((e) => !items.some((old) => old.id === e.id)),
          ],
          exhausted: result.data.length < 100,
        });
    } catch (e) {
      if (seq === eventSeq.current) setEventsError(e);
    } finally {
      if (seq === eventSeq.current) setEventsBusy(false);
    }
  };
  const data = payload?.data;
  const roots =
    data?.projects.filter((p) => !p.parent_id && p.status === filter) ?? [];
  const normalized = query.trim().toLocaleLowerCase("ru");
  const rows = roots.filter(
    (p) =>
      !normalized ||
      `${p.title} ${p.current_task?.title ?? ""}`
        .toLocaleLowerCase("ru")
        .includes(normalized),
  );
  const events =
    allEvents?.project === attentionProject
      ? allEvents.items
      : attentionProject === "all"
        ? (data?.attention ?? [])
        : [];
  const attentionTotal = data
    ? attentionCount(
        attentionProject === "all" ? null : attentionProject,
        data.projects,
      )
    : 0;
  const hasMoreEvents = events.length < attentionTotal && !allEvents?.exhausted;
  const selectedEvent = detail?.kind === "event" ? detail.event : null;
  const detailTitle =
    detail?.title ?? selectedEvent?.reason ?? "Текущее состояние";
  const activeCount = data?.active_runs.length ?? 0;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <i />
            <i />
          </div>
          <div className="brand-title">
            Совместная
            <br /> работа
          </div>
          <p>Личное пространство</p>
        </div>
        <nav aria-label="Меню плагина">
          {[
            ["folder", "Проекты"],
            ["file", "Материалы"],
            ["clock", "История"],
            ["star", "Возможности"],
          ].map(([icon, label], i) => (
            <button
              key={label}
              className={`nav-item ${i === 0 ? "selected" : ""}`}
              aria-current={i === 0 ? "page" : undefined}
              disabled={i !== 0}
              title={i ? "Раздел появится на следующем этапе" : undefined}
            >
              <Icon name={icon} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="main">
        <header className="page-header">
          <div>
            <h1>Проекты</h1>
            <p>Все места продолжения — на одном экране</p>
          </div>
          <button
            className="icon-button refresh"
            onClick={refresh}
            disabled={!ready || refreshing}
            aria-label="Обновить данные"
            title="Обновить данные"
          >
            <Icon name="refresh" className={refreshing ? "rotating" : ""} />
          </button>
        </header>
        <div className="workspace-grid">
          <section className="projects-section" aria-label="Проекты">
            <div className="toolbar">
              <label className="search-field">
                <Icon name="search" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Найти проект или материал"
                  aria-label="Найти проект или материал"
                  maxLength={300}
                />
                {query && (
                  <button
                    className="icon-button"
                    onClick={() => setQuery("")}
                    aria-label="Очистить поиск"
                  >
                    <Icon name="close" />
                  </button>
                )}
              </label>
              <button
                className="primary-button"
                disabled={!ready}
                onClick={() => {
                  setSaveError(null);
                  createAttempt.current = null;
                  setTitle("");
                  setCreateOpen(true);
                }}
              >
                <Icon name="plus" />
                Новый проект
              </button>
            </div>
            {normalized && (
              <div className="search-results" aria-live="polite">
                <div className="search-label">
                  Поиск по проектам, задачам и материалам
                </div>
                {searchError ? (
                  <p className="error-text">{friendlyError(searchError)}</p>
                ) : search === null ? (
                  <p className="muted">Ищем…</p>
                ) : search.length === 0 ? (
                  <p className="muted">Совпадений нет</p>
                ) : (
                  search.map((item) => (
                    <button
                      key={`${item.type}:${item.id}:${item.work_item_id}`}
                      className="search-result"
                      onClick={() => openSearch(item)}
                    >
                      <Icon
                        name={item.type === "project" ? "folder" : "file"}
                      />
                      <span>{item.title}</span>
                      <small>
                        {
                          {
                            project: "Проект",
                            task: "Задача",
                            decision: "Решение",
                            material: "Материал",
                          }[item.type]
                        }
                      </small>
                      <Icon name="arrow" />
                    </button>
                  ))
                )}
              </div>
            )}
            <div className="section-header">
              <h2>
                {filter === "active" ? "Активные проекты" : "Архив"}
                <span className="count">{roots.length}</span>
              </h2>
              <div
                className="segmented"
                role="group"
                aria-label="Состояние проектов"
              >
                <button
                  aria-pressed={filter === "active"}
                  onClick={() => setFilter("active")}
                >
                  Активные
                </button>
                <button
                  aria-pressed={filter === "archived"}
                  onClick={() => setFilter("archived")}
                >
                  Архив
                </button>
              </div>
            </div>
            {error && (
              <div className="error-banner" role="alert">
                <p>{friendlyError(error)}</p>
                {error.message === "auth_required" ? (
                  <button
                    className="soft-button"
                    onClick={() => setDetail({ kind: "login", title: "Войти" })}
                  >
                    Войти
                  </button>
                ) : (
                  <button
                    className="soft-button"
                    onClick={() => {
                      if (!ready) location.reload();
                      else refresh();
                    }}
                  >
                    Повторить
                  </button>
                )}
                {data && <small>Показаны данные предыдущей загрузки.</small>}
              </div>
            )}
            {!data && !error ? (
              <div
                className="skeleton-list"
                aria-label="Загрузка проектов"
                aria-busy="true"
              >
                {Array.from({ length: 5 }, (_, i) => (
                  <div className="skeleton-row" key={i}>
                    <i />
                    <div>
                      <i />
                      <i />
                    </div>
                  </div>
                ))}
              </div>
            ) : data && rows.length === 0 ? (
              <div className="empty-state">
                <Icon name="folder" />
                <h3>
                  {normalized
                    ? "В списке нет совпадений"
                    : filter === "archived"
                      ? "Архив пока пуст"
                      : "Первый проект начинается здесь"}
                </h3>
                <p>
                  {normalized
                    ? "Проверьте результаты общего поиска выше."
                    : filter === "archived"
                      ? "Здесь будут завершённые проекты."
                      : "Создайте проект. Его задачи и материалы будут собраны в одном месте."}
                </p>
                {filter === "active" && !normalized && (
                  <button
                    className="soft-button"
                    onClick={() => setCreateOpen(true)}
                  >
                    Создать проект
                    <Icon name="arrow" />
                  </button>
                )}
              </div>
            ) : (
              <div className="project-list">
                {rows.map((p) => {
                  const status = rowStatus(p, data);
                  const count = attentionCount(p.id, data.projects);
                  return (
                    <article key={p.id} className="project-row">
                      <Icon name="folder" className="project-folder" />
                      <div className="project-name">
                        <button onClick={() => openProject(p)}>
                          {p.title}
                        </button>
                        <p>
                          {p.current_task
                            ? `Текущая задача: ${p.current_task.title}`
                            : "Текущая задача не выбрана"}
                        </p>
                      </div>
                      <div className="project-progress">
                        <p>
                          {count
                            ? `Открытых событий: ${count}`
                            : p.current_task
                              ? "Состояние текущей задачи"
                              : "Изменения в проекте"}
                        </p>
                        <time dateTime={p.last_change_at ?? p.updated_at}>
                          {dateLabel(p.last_change_at ?? p.updated_at)}
                        </time>
                        <Notice kind={status} small />
                      </div>
                      <button
                        className="open-button"
                        onClick={() => openProject(p)}
                        aria-label={`Открыть проект ${p.title}`}
                      >
                        Открыть
                        <Icon name="arrow" />
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
            {data && activeCount > 0 && (
              <section className="active-runs">
                <h3>
                  Текущая работа <span className="count">{activeCount}</span>
                </h3>
                {data.active_runs.map((r) => (
                  <div key={r.id} className="run-row">
                    <Icon name="clock" />
                    <button
                      onClick={() =>
                        setDetail({
                          kind: "task",
                          id: r.work_item_id,
                          title:
                            data.projects.find((p) => p.id === r.project_id)
                              ?.title ?? "Текущая работа",
                        })
                      }
                    >
                      {data.projects.find((p) => p.id === r.project_id)
                        ?.title ?? "Проект"}
                    </button>
                    <span>{runLabels[r.status] ?? "Запуск не завершён"}</span>
                  </div>
                ))}
              </section>
            )}
          </section>
          <aside className="attention-section" aria-label="Внимание">
            <div className="attention-top">
              <h2>
                Внимание<span className="count">{attentionTotal}</span>
              </h2>
              <label className="attention-filter">
                <span className="sr-only">Фильтр внимания по проекту</span>
                <select
                  value={attentionProject}
                  onChange={(e) => setAttentionProject(e.target.value)}
                >
                  <option value="all">Все проекты</option>
                  {data?.projects
                    .filter((p) => !p.parent_id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                </select>
                <Icon name="chevron" />
              </label>
            </div>
            {!data || (eventsBusy && events.length === 0) ? (
              <div
                className="skeleton-card"
                aria-label="Загрузка событий"
                aria-busy="true"
              />
            ) : eventsError && events.length === 0 ? (
              <p className="error-text" role="alert">
                {friendlyError(eventsError)}
                <button className="soft-button" onClick={showAllEvents}>
                  Повторить
                </button>
              </p>
            ) : events.length === 0 ? (
              <div className="attention-empty">
                <span className="calm-check">
                  <Icon name="check" />
                </span>
                <h3>Можно спокойно работать</h3>
                <p>
                  {attentionProject === "all"
                    ? "Открытых событий нет."
                    : "В этом проекте нет открытых событий."}
                </p>
              </div>
            ) : (
              <div className="attention-list">
                {events.map((event) => {
                  const kind =
                    attentionKinds[event.type] ??
                    attentionKinds.change_detected;
                  return (
                    <article className="attention-card" key={event.id}>
                      <div className="attention-card-top">
                        <Notice kind={kind} />
                        <time dateTime={event.created_at}>
                          {dateLabel(event.created_at).split(", ").pop()}
                        </time>
                      </div>
                      <div className="attention-body">
                        <p className="attention-context">
                          {event.project_title}
                          {event.work_item_title &&
                            ` · ${event.work_item_title}`}
                        </p>
                        <h3>{event.reason}</h3>
                        <button
                          className="soft-button"
                          onClick={() =>
                            setDetail({
                              kind: "event",
                              event,
                              title: event.reason,
                            })
                          }
                        >
                          {kind.action}
                          <Icon name="arrow" />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            {data && hasMoreEvents && (
              <button
                className="all-events"
                disabled={eventsBusy}
                onClick={showAllEvents}
              >
                {eventsBusy ? "Загружаем…" : "Показать ещё события"}
                <Icon name="arrow" />
              </button>
            )}
            {eventsError && events.length > 0 && (
              <p className="error-text" role="alert">
                {friendlyError(eventsError)}
              </p>
            )}
          </aside>
        </div>
        <footer className="data-footer" aria-live="polite">
          <span className={`sync-dot ${error ? "stale" : ""}`} />
          <span>
            {data
              ? `${error ? "Последняя загрузка" : "Данные обновлены"}: ${dateLabel(payload.server_time)}`
              : "Загружаем рабочее пространство"}
          </span>
          <span className="footer-divider" />
          <span>
            {data
              ? activeCount
                ? `Незавершённых запусков: ${activeCount}`
                : "Нет активных запусков"
              : "Статус запусков загружается"}
          </span>
        </footer>
      </main>
      {createOpen && (
        <Dialog
          title="Новый проект"
          onClose={() => {
            if (!saving) setCreateOpen(false);
          }}
        >
          <form onSubmit={save}>
            <label className="form-label">
              Название проекта
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={saving || !!createAttempt.current}
                maxLength={2000}
                required
                placeholder="Например, ЯКС"
              />
            </label>
            <p className="muted">
              Создаётся пустой проект. Работа и расписания не запускаются.
            </p>
            {saveError && (
              <p className="error-text" role="alert">
                Не удалось подтвердить сохранение. Повторная проверка использует
                тот же запрос.
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => setCreateOpen(false)}
                disabled={saving}
              >
                Отмена
              </button>
              <button
                className="primary-button solid"
                disabled={saving || !title.trim()}
              >
                {saving
                  ? "Сохраняем…"
                  : saveError
                    ? "Проверить и повторить"
                    : "Создать проект"}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {detail && detail.kind !== "login" && (
        <Dialog title={detailTitle} wide onClose={() => setDetail(null)}>
          {selectedEvent && (
            <div className="detail-event">
              <Notice
                kind={
                  attentionKinds[selectedEvent.type] ??
                  attentionKinds.change_detected
                }
              />
              <p>
                {selectedEvent.project_title}
                {selectedEvent.work_item_title &&
                  ` · ${selectedEvent.work_item_title}`}
              </p>
              <time>{dateLabel(selectedEvent.created_at)}</time>
              {!selectedEvent.work_item_id && (
                <button
                  className="soft-button"
                  onClick={() =>
                    setDetail({
                      kind: "project",
                      id: selectedEvent.project_id,
                      title: selectedEvent.project_title,
                    })
                  }
                >
                  Открыть проект
                  <Icon name="arrow" />
                </button>
              )}
            </div>
          )}
          {detailError ? (
            <p className="error-text" role="alert">
              {friendlyError(detailError)}
            </p>
          ) : detailData ? (
            <div className="detail-content">
              {detailData.path && (
                <p className="breadcrumb">
                  {detailData.path.map((p) => p.title).join(" / ")}
                </p>
              )}
              {detailData.goal !== undefined && (
                <>
                  <h3>Состояние</h3>
                  <p>
                    <Notice
                      kind={{
                        label:
                          taskLabels[detailData.status] ?? detailData.status,
                        tone: "muted",
                        icon: "dot",
                      }}
                    />
                  </p>
                  <p className="preserve-lines">
                    {detailData.goal || "Цель пока не описана."}
                  </p>
                </>
              )}
              {detailData.work_items && (
                <>
                  <h3>
                    Задачи{" "}
                    <span className="count">
                      {detailData.work_items.length}
                    </span>
                  </h3>
                  {detailData.work_items.length ? (
                    detailData.work_items.map((w) => (
                      <button
                        key={w.id}
                        className="detail-row"
                        onClick={() =>
                          setDetail({ kind: "task", id: w.id, title: w.title })
                        }
                      >
                        <span>
                          {w.title}
                          <small>
                            {taskLabels[w.status] ?? w.status}
                            {w.id === detailData.current_work_item_id
                              ? " · Текущая задача"
                              : ""}
                          </small>
                        </span>
                        <Icon name="arrow" />
                      </button>
                    ))
                  ) : (
                    <p className="muted">Задач пока нет.</p>
                  )}
                </>
              )}
              {detailData.children?.length > 0 && (
                <>
                  <h3>Подпроекты</h3>
                  {detailData.children.map((p) => (
                    <button
                      key={p.id}
                      className="detail-row"
                      onClick={() => openProject(p)}
                    >
                      <Icon name="folder" />
                      {p.title}
                      <Icon name="arrow" />
                    </button>
                  ))}
                </>
              )}
              {detailData.materials && (
                <>
                  <h3>Материалы</h3>
                  {detailData.materials.length ? (
                    detailData.materials.map((m) => (
                      <button
                        className="detail-row"
                        key={m.id}
                        onClick={() =>
                          setDetail({
                            kind: "material",
                            id: m.id,
                            title: m.title,
                          })
                        }
                      >
                        <Icon name="file" />
                        {m.title}
                        <Icon name="arrow" />
                      </button>
                    ))
                  ) : (
                    <p className="muted">Материалы не добавлены.</p>
                  )}
                </>
              )}
              {detailData.proposals?.length > 0 && (
                <>
                  <h3>Решения и предложения</h3>
                  {detailData.proposals.map((p) => (
                    <div key={p.id} className="proposal">
                      <span className="muted">
                        {p.status === "accepted"
                          ? "Принято"
                          : p.status === "revoked"
                            ? "Отозвано"
                            : "Предложено"}
                      </span>
                      <p className="preserve-lines">{p.body?.statement}</p>
                      {p.body?.open_question && <p>{p.body.open_question}</p>}
                    </div>
                  ))}
                </>
              )}
              {detail.kind === "material" && (
                <div className="material-content">
                  <p className="preserve-lines">
                    {detailData.version?.content ??
                      "Содержимое этого материала доступно в его источнике."}
                  </p>
                </div>
              )}
            </div>
          ) : (
            (!selectedEvent || selectedEvent.work_item_id) && (
              <p className="muted" aria-busy="true">
                Загружаем состояние…
              </p>
            )
          )}
        </Dialog>
      )}
      {detail?.kind === "login" && (
        <Login
          onClose={() => setDetail(null)}
          onSuccess={() => location.reload()}
        />
      )}
    </div>
  );
}
function Login({ onClose, onSuccess }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  return (
    <Dialog title="Войти" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(false);
          const fields = new FormData(e.currentTarget);
          try {
            const r = await fetch("/login", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                login: fields.get("login"),
                password: fields.get("password"),
              }),
            });
            if (!r.ok) throw new Error();
            onSuccess();
          } catch {
            setError(true);
            setBusy(false);
          }
        }}
      >
        <p className="muted">Используйте существующий логин приложения.</p>
        <label className="form-label">
          Логин
          <input
            name="login"
            autoFocus
            autoComplete="username"
            required
            maxLength={128}
          />
        </label>
        <label className="form-label">
          Пароль
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            Вход не подтверждён. Проверьте данные и повторите.
          </p>
        )}
        <div className="dialog-actions">
          <button className="primary-button solid" disabled={busy}>
            {busy ? "Входим…" : "Войти"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
createRoot(document.getElementById("root")).render(<Workspace />);
