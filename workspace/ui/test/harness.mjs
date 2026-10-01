import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  serveWorkspaceWeb,
  readWorkspaceResource,
} from "../../../src/workspace-web.ts";
export function fixture() {
  const names = [
    "ЯКС",
    "Бот для салона",
    "История Winline",
    "Игра «Точки»",
    "Арбитраж трафика",
    "Бар",
    "Недетские сказки",
  ];
  const tasks = [
    "Анонс первого тура",
    "Запись клиентов",
    "Серверная часть",
    "Онлайн-прототип",
    "Первый тест",
    "Концепция",
    "Первый выпуск",
  ];
  const projects = names.map((title, i) => ({
    id: randomUUID(),
    parent_id: null,
    title,
    status: "active",
    created_at: "2026-09-29T09:00:00Z",
    updated_at: `2026-10-01T0${9 - i}:00:00Z`,
    last_change_at: `2026-10-01T0${9 - i}:00:00Z`,
    current_task: {
      id: randomUUID(),
      title: tasks[i],
      status: i === 2 ? "blocked" : "active",
    },
    open_attention: i < 3 ? 1 : 0,
    attention_types:
      i === 0
        ? ["decision_required"]
        : i === 1
          ? ["result_ready"]
          : i === 2
            ? ["obstacle"]
            : [],
  }));
  const attention = projects.slice(0, 3).map((p, i) => ({
    id: randomUUID(),
    project_id: p.id,
    work_item_id: p.current_task.id,
    project_title: p.title,
    work_item_title: p.current_task.title,
    type: ["decision_required", "result_ready", "obstacle"][i],
    reason: [
      "Указать время матчей",
      "Сценарий записи подготовлен",
      "Источник требует подключения",
    ][i],
    created_at: `2026-10-01T09:0${3 - i}:00Z`,
    state: "open",
  }));
  return {
    workspace: { title: "Synthetic fixture", timezone: "Europe/Moscow" },
    projects,
    attention,
    active_runs: [],
  };
}
export async function createHarness() {
  const state = {
    data: fixture(),
    requests: [],
    mode: "normal",
    createDelay: 0,
    workspaceDelay: 0,
    receipts: new Map(),
    loseCreateResponse: false,
  };
  const envelope = (data) => ({ data, server_time: new Date().toISOString() });
  const run = async (op, input = {}) => {
    state.requests.push({ op, input });
    if (op === "workspace_get") {
      const snapshot = envelope(
        structuredClone({
          ...state.data,
          attention: state.data.attention.slice(0, 50),
        }),
      );
      if (state.workspaceDelay)
        await new Promise((resolve) =>
          setTimeout(resolve, state.workspaceDelay),
        );
      if (state.mode === "failed")
        return { error: { code: "service_unavailable" } };
      return snapshot;
    }
    if (op === "attention_list") {
      let rows = state.data.attention.filter(
        (e) =>
          !input.project_id ||
          e.project_id === input.project_id ||
          (input.include_descendants &&
            state.data.projects.find((p) => p.id === e.project_id)
              ?.parent_id === input.project_id),
      );
      if (input.before_id) {
        const i = rows.findIndex((e) => e.id === input.before_id);
        rows = rows.slice(i + 1);
      }
      return envelope(rows.slice(0, input.limit ?? 50));
    }
    if (op === "project_get") {
      const p = state.data.projects.find((p) => p.id === input.id);
      return envelope({
        ...p,
        path: [{ title: p.title, id: p.id }],
        work_items: p.current_task
          ? [
              {
                ...p.current_task,
                goal: "Синтетический сценарий проверки",
                project_id: p.id,
              },
            ]
          : [],
        children: [],
      });
    }
    if (op === "work_item_get") {
      const p = state.data.projects.find(
        (p) => p.current_task?.id === input.id,
      );
      return envelope({
        ...p.current_task,
        goal: "Синтетический сценарий проверки",
        materials: [],
        proposals: [],
        runs: [],
      });
    }
    if (op === "search")
      return envelope(
        state.data.projects
          .filter((p) => p.title.toLowerCase().includes(input.q.toLowerCase()))
          .map((p) => ({
            type: "project",
            id: p.id,
            title: p.title,
            project_id: p.id,
            work_item_id: null,
          })),
      );
    if (op === "operation_status_get") {
      const receipt = state.receipts.get(input.operation_id);
      if (!receipt) return { error: { code: "not_found" } };
      return envelope({ result: receipt });
    }
    if (op === "project_create") {
      if (state.createDelay)
        await new Promise((resolve) => setTimeout(resolve, state.createDelay));
      let p = state.receipts.get(input.operation_id);
      if (!p) {
        p = {
          id: randomUUID(),
          title: input.title,
          parent_id: null,
          status: "active",
          updated_at: new Date().toISOString(),
          open_attention: 0,
        };
        state.data.projects.push(p);
        state.receipts.set(input.operation_id, p);
      }
      if (state.loseCreateResponse) {
        state.loseCreateResponse = false;
        return { error: { code: "simulated_lost_response" } };
      }
      return envelope(p);
    }
    return { error: { code: "not_found" } };
  };
  const host = `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body style="margin:0"><div style="height:24px;font:12px Arial;background:#ece9ff;color:#584991;text-align:center;line-height:24px">Синтетические данные · Проверка первого экрана</div><iframe title="Проверка плагина" src="/resource" style="width:100%;height:calc(100vh - 24px);border:0"></iframe><script>
    const frame=document.querySelector('iframe');let initial=false;
    window.addEventListener('message',async event=>{
      if(event.source!==frame.contentWindow)return;const request=event.data;const reply=result=>event.source.postMessage({jsonrpc:'2.0',id:request.id,result},'*');
      if(request.method==='ui/initialize')reply({protocolVersion:request.params.protocolVersion,hostInfo:{name:'synthetic-host',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{displayMode:'fullscreen',availableDisplayModes:['fullscreen']}});
      else if(request.method==='ui/notifications/initialized'&&!initial){initial=true;const result=await(await fetch('/control/read',{method:'POST',body:JSON.stringify({op:'workspace_get',input:{}})})).json();frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[],structuredContent:result}},'*');}
      else if(request.method==='tools/call'){const result=await(await fetch('/control/read',{method:'POST',body:JSON.stringify({op:request.params.name.replace(/^workspace_/,''),input:request.params.arguments})})).json();reply({content:[],structuredContent:result,...(result.error?{isError:true}:{})});}
      else if(request.id!==undefined)reply({});
    });</script></body></html>`;
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.url === "/plugin") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(host);
        return;
      }
      if (req.url === "/resource") {
        const resource = await readWorkspaceResource();
        res.writeHead(200, { "content-type": "text/html" });
        res.end(resource.contents[0].text);
        return;
      }
      if (req.url.startsWith("/control/")) {
        const chunks = [];
        for await (const b of req) chunks.push(b);
        const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if (req.url === "/control/read") {
          send(200, await run(input.op, input.input));
          return;
        }
        if (req.url === "/control/state") {
          if (input.mode) state.mode = input.mode;
          if (input.data) state.data = input.data;
          if (input.clear_requests) state.requests = [];
          if (input.createDelay !== undefined)
            state.createDelay = input.createDelay;
          if (input.loseCreateResponse !== undefined)
            state.loseCreateResponse = input.loseCreateResponse;
          send(200, { data: state.data, requests: state.requests });
          return;
        }
      }
      if (req.url === "/workspace" || req.url === "/workspace/") {
        await serveWorkspaceWeb(req, res);
        return;
      }
      if (req.url === "/workspace/api/session") {
        if (state.mode === "unauthenticated") send(401, {});
        else send(200, { csrf_token: "synthetic-csrf" });
        return;
      }
      if (req.url === "/workspace/api/workspace") {
        if (state.mode === "failed") send(503, {});
        else send(200, await run("workspace_get"));
        return;
      }
      if (req.url.startsWith("/workspace/api/operations/")) {
        const chunks = [];
        for await (const b of req) chunks.push(b);
        const result = await run(
          req.url.split("/").pop(),
          JSON.parse(Buffer.concat(chunks).toString()),
        );
        send(
          result.error ? (result.error.code === "not_found" ? 404 : 500) : 200,
          result,
        );
        return;
      }
      send(404, {});
    } catch (error) {
      send(500, { error: { code: error.message } });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    state,
    run,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
if (process.argv.includes("--serve")) {
  const h = await createHarness();
  console.log(h.url);
}
