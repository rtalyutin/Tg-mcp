import { mailSections, type MailCard } from './mail-ui.ts';
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const e = escapeHtml;
const statuses: Record<string, string> = { needs_review: 'Требует проверки', resolved: 'Подтверждён',
  candidate: 'Кандидат', preparing: 'Подготовка', awaiting_approval: 'На согласовании',
  awaiting_reply: 'Ждём ответа', reply_received: 'Есть ответ', negotiating: 'Обсуждаем',
  agreed: 'Договорились', declined: 'Отказ', deferred: 'Отложено' };
const badge = (status: string) => `<span class="status status-${e(status)}">${e(statuses[status] ?? status)}</span>`;
const date = (value: unknown) => value ? e(new Date(String(value)).toLocaleString('ru-RU', { timeZone: 'UTC' })) : '—';
type Card = { id: string; kind: string; name: string; website: string | null; version: number;
  status: string; updated_at: string; contacts: Array<Record<string, unknown>>;
  opportunities: Array<Record<string, unknown>>; sources?: Array<Record<string, unknown>>;
  rationale?: string; inn?: string | null; sector?: string | null; city?: string | null;
  possible_matches?: Array<Record<string, unknown>>; history?: Array<Record<string, unknown>>; mail?:MailCard[] };

function layout(title: string, body: string, csrf = '') {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="${e(csrf)}"><title>${e(title)} · YCS</title>
    <link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js" defer></script></head>
    <body><header><a class="brand" href="/">YAR CYBER SEASON <span>Партнёры</span></a><a href="/dashboard/">Следующий ход · демо</a>${csrf ? '<form data-action="logout"><button class="quiet">Выйти</button></form>' : ''}</header>
    <main>${body}<p id="feedback" role="status" aria-live="polite"></p></main></body></html>`;
}
export function loginPage() {
  return layout('Вход', `<section class="login panel"><p class="eyebrow">Личный кабинет</p><h1>Войти в реестр</h1>
    <form data-action="login"><label>Логин<input name="login" autocomplete="username" maxlength="128" required></label>
    <label>Пароль<input name="password" type="password" autocomplete="current-password" maxlength="256" required></label>
    <button>Войти</button></form></section>`);
}
export function unavailablePage() { return layout('Сервис недоступен', '<section class="panel"><h1>Сервис временно недоступен</h1><p>Попробуйте позже.</p></section>'); }
function sourceFields() { return `<label>Источник<input name="source_url" type="url" placeholder="https://…" required></label>
  <label>Почему компания подходит<textarea name="rationale" maxlength="4000" required></textarea></label>`; }
export function tablePage(data: { items: Card[]; next_cursor: string | null }, csrf: string, filters: { q?: string; status?: string }) {
  const rows = data.items.map(c => {
    const contacts = c.contacts.map(x => e(x.email)).join('<br>') || '—';
    const ops = c.opportunities.length ? c.opportunities : [null];
    return ops.map((o, i) => `<tr>${i === 0 ? `<td rowspan="${ops.length}"><a href="/companies/${e(c.id)}">${e(c.name)}</a><small>${e(c.website ?? '')}</small></td>` : ''}
      <td>${contacts}</td><td>${o ? e(o.subject) : '—'}</td><td>${o ? badge(String(o.status)) : c.kind === 'candidate' ? badge(c.status) : '<span class="muted">Переговоры не созданы</span>'}</td>
      <td>${date(o?.updated_at ?? c.updated_at)}</td><td>${o?.next_step ? e(o.next_step) : 'Следующий шаг не задан'}<small>${date(o?.next_step_at)}</small></td></tr>`).join('');
  }).join('');
  return layout('Компании', `<div class="heading"><div><p class="eyebrow">Реестр партнёров</p><h1>Компании и переговоры</h1></div><span class="counter">${data.items.length} в выборке</span></div>
    <form method="get" class="filters"><label>Поиск<input name="q" value="${e(filters.q ?? '')}" placeholder="Название или сайт"></label>
    <label>Статус<select name="status"><option value="">Все</option>${Object.entries(statuses).filter(([key]) => key !== 'resolved').map(([key, label]) => `<option value="${key}"${filters.status === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label><button>Найти</button></form>
    <section class="panel table-wrap"><table><thead><tr><th>Компания</th><th>Контакт</th><th>Предмет предложения</th><th>Статус</th><th>Последнее действие · UTC</th><th>Следующий шаг · UTC</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Здесь пока нет компаний. Добавьте первую с источником.</td></tr>'}</tbody></table></section>
    ${data.next_cursor ? `<a class="next" href="/?${e(new URLSearchParams({ q: filters.q ?? '', status: filters.status ?? '', cursor: data.next_cursor }).toString())}">Следующая страница →</a>` : ''}
    <details class="panel add"><summary>Добавить компанию</summary><form data-action="candidate"><label>Название<input name="name" maxlength="300" required></label><label>Сайт<input name="website" type="url"></label>${sourceFields()}<button>Сохранить на проверку</button></form></details>`, csrf);
}
export function cardPage(c: Card, csrf: string) {
  const candidate = c.kind === 'candidate';
  const sources = (c.sources ?? []).map(s => `<li>${s.url ? `<a href="${e(s.url)}" rel="noreferrer noopener" target="_blank">${e(s.url)}</a>` : e(s.material_id)}<p>${e(s.claim)}</p><small>${e(s.verification)}</small></li>`).join('');
  const matches = (c.possible_matches ?? []).map(m => `<li><a href="/companies/${e(m.id)}">${e(m.name)}</a><small>${e(m.kind === 'company' ? 'Компания' : 'Кандидат')} · ID ${e(m.id)}</small></li>`).join('');
  const history = (c.history ?? []).map(h => `<li>${date(h.created_at)} · ${e(h.action ?? h.operation ?? h.command ?? 'Изменение')}<small>${e(h.actor_id ?? '')}</small></li>`).join('');
  const ops = c.opportunities.map(o => `<article class="opportunity"><h3>${e(o.subject)}</h3>${badge(String(o.status))}<p>${e(o.next_step || 'Следующий шаг не задан')}</p><small>${date(o.next_step_at)}</small><details><summary>Статус и следующий шаг</summary><form data-action="status" data-id="${e(o.id)}" data-version="${e(o.version)}"><label>Статус<select name="status">${['candidate','preparing','negotiating','agreed','declined','deferred'].map(key => `<option value="${key}"${o.status === key ? ' selected' : ''}>${statuses[key]}</option>`).join('')}</select></label><label>Следующий шаг<input name="next_step" value="${e(o.next_step ?? '')}"></label><label>Дата и время · UTC<input name="next_step_at" type="datetime-local" value="${o.next_step_at ? e(new Date(String(o.next_step_at)).toISOString().slice(0,16)) : ''}"></label><label>Основание / причина<textarea name="reason"></textarea></label><label>Содержание договорённости (для «Договорились»)<textarea name="agreement"></textarea></label><button>Сохранить</button></form></details></article>`).join('');
  return layout(c.name, `<a class="back" href="/">← Все компании</a><div class="heading"><div><p class="eyebrow">${candidate ? 'Кандидат' : 'Компания'} · версия ${c.version}</p><h1>${e(c.name)}</h1></div>${candidate ? badge(c.status) : ''}</div>
    <div class="grid"><section class="panel"><h2>Сведения</h2><p>${c.website ? `<a href="${e(c.website)}" target="_blank" rel="noreferrer noopener">${e(c.website)}</a>` : 'Сайт не указан'}</p><p>${e(c.rationale)}</p><p>${e(c.city ?? '')}</p>${matches ? `<h3>Возможные совпадения</h3><ul>${matches}</ul>` : ''}<h3>Источники</h3><ul class="sources">${sources || '<li>Нет источников</li>'}</ul>${history ? `<details><summary>История изменений</summary><ul>${history}</ul></details>` : ''}
    ${candidate && c.status !== 'resolved' ? `<form data-action="resolve" data-id="${e(c.id)}" data-version="${c.version}"><label>Связать с существующей компанией (ID, необязательно)<input name="company_id"></label><button>Подтвердить компанию</button></form>` : ''}
    ${!candidate ? `<details><summary>Изменить сведения</summary><form data-action="edit-company" data-id="${e(c.id)}" data-version="${c.version}"><label>Название<input name="name" value="${e(c.name)}" required></label><label>Сайт<input name="website" type="url" value="${e(c.website)}"></label>${sourceFields()}<button>Сохранить новую версию</button></form></details>` : ''}</section>
    <section class="panel"><h2>Контакты</h2>${c.contacts.map(x => `<p>${e(x.name)} <strong>${e(x.email)}</strong></p>`).join('') || '<p class="muted">Контакты не добавлены</p>'}
    ${!candidate ? `<details><summary>Добавить контакт</summary><form data-action="contact" data-id="${e(c.id)}"><label>Email<input name="email" type="email" required></label><label>Имя<input name="name"></label>${sourceFields()}<button>Сохранить контакт</button></form></details>` : ''}
    <h2>Переговоры</h2>${ops || '<p class="muted">Переговоры не созданы</p>'}${!candidate ? `<details><summary>Новый предмет предложения</summary><form data-action="opportunity" data-id="${e(c.id)}"><label>Предмет<input name="subject" required maxlength="300"></label>${sourceFields()}<button>Создать переговоры</button></form></details>` : ''}</section></div>
    ${!candidate ? mailSections(c.opportunities,c.mail ?? []) : ''}`, csrf);
}

export const stylesheet = `:root{font-family:system-ui,-apple-system,sans-serif;color:#e9edf3;background:#11151c;color-scheme:dark}*{box-sizing:border-box}body{margin:0}header{padding:20px 4vw;border-bottom:1px solid #303642;display:flex;justify-content:space-between;align-items:center}.brand{font-size:13px;font-weight:800;letter-spacing:.08em;text-decoration:none;color:#f5f7fa}.brand span{display:block;color:#9da9bc;letter-spacing:0;font-weight:400;margin-top:5px}main{max-width:1500px;margin:0 auto;padding:36px 4vw}a{color:#91ddd0}h1{font-size:clamp(25px,3vw,36px);line-height:1.2;margin:7px 0 25px}h2{font-size:19px;margin:4px 0 20px}h3{font-size:16px}p{line-height:1.5;overflow-wrap:anywhere}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#a6b3c7}.heading{display:flex;align-items:center;justify-content:space-between;gap:20px}.counter,.muted,small{color:#9da9bc}small{display:block;font-size:12px;margin-top:7px;overflow-wrap:anywhere}.panel{background:#1b212b;border:1px solid #343c4a;border-radius:12px;padding:24px;margin:20px 0}.table-wrap{padding:0;overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:14px;min-width:850px}th{font-size:12px;color:#a6b3c7;background:#202733}td,th{padding:18px 16px;border-bottom:1px solid #343c4a;vertical-align:top}tr:last-child td{border-bottom:0}td:first-child{min-width:175px}td a{font-weight:650}.status{display:inline-block;font-size:12px;border-radius:6px;padding:6px 9px;background:#333d50;color:#e4ebff;white-space:nowrap}.status-needs_review,.status-awaiting_approval{background:#4b402b;color:#ffe0a0}.status-agreed{background:#234739;color:#b1f0d5}.status-declined{background:#50343d;color:#ffd0d9}.empty{text-align:center;padding:55px 25px;color:#a6b3c7}.filters{display:flex;gap:16px;align-items:end}.filters label:first-child{flex:1}.filters label{margin:0}label{display:block;font-size:13px;color:#bac5d6;margin:15px 0}input,select,textarea{display:block;width:100%;font:inherit;padding:12px;margin-top:7px;background:#111820;color:#f5f7fa;border:1px solid #566176;border-radius:7px}textarea{min-height:85px}button{background:#96e1d0;color:#101f1d;border:0;border-radius:7px;padding:12px 18px;font-weight:750;cursor:pointer;font-size:14px}button:disabled{opacity:.5;cursor:wait}.quiet{background:transparent;color:#a6b3c7}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #b6f7e5;outline-offset:3px}.login{max-width:440px;margin:8vh auto}.login button{width:100%}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.grid .panel{min-width:0}.sources{padding-left:18px}.sources li{margin-bottom:22px;overflow-wrap:anywhere}summary{cursor:pointer;color:#91ddd0;padding:8px 0}.add{max-width:700px}.back{display:inline-block;margin-bottom:20px}.opportunity{border-top:1px solid #343c4a;padding:20px 0}.next{display:inline-block;margin-bottom:20px}.mail-body{white-space:pre-wrap;overflow-wrap:anywhere;background:#101820;padding:16px;border-radius:8px}.mail-actions{display:flex;flex-wrap:wrap;gap:12px}.mail-actions form{max-width:100%}#feedback{color:#ffe0a0;position:sticky;bottom:0;background:#11151c;padding:12px;border-radius:7px}#feedback:empty{display:none}@media(max-width:700px){main{padding:24px 16px}.filters{flex-wrap:wrap}.filters label{flex:1;min-width:135px}.heading{display:block}.grid{grid-template-columns:1fr;gap:0}.panel{padding:18px}.table-wrap{padding:0}.brand{font-size:11px}header{padding:16px}.counter{font-size:12px}table{min-width:800px}}`;

// Local requests are deliberately paced; only a confirmed 429 is retried, with the same request_id.
export const browserScript = `let lastRequest = Date.now();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pace = async () => { await wait(Math.max(0, 1100 - (Date.now() - lastRequest))); lastRequest = Date.now(); };
const feedback = message => { document.getElementById('feedback').textContent = message; };
const csrf = document.querySelector('meta[name="csrf-token"]').content;
const source = data => ({ url: data.source_url, retrieved_at: new Date().toISOString(), claim: data.rationale, verification: 'Указано владельцем; не проверено приложением' });
async function request(path, body) {
  for (let n = 0; n < 4; n++) {
    await pace();
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
    if (response.status === 429) { await wait(Math.max(1, Number(response.headers.get('retry-after')) || 1) * 1000); continue; }
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.code === 'VERSION_CONFLICT' ? 'Запись уже изменилась. Обновите страницу.' : result.code === 'SERVICE_UNAVAILABLE' ? 'Сервис временно недоступен. Попробуйте позже.' : 'Не удалось выполнить действие: ' + (result.code || 'ошибка сервиса')); error.definite = response.status < 500; throw error; }
    return result;
  }
  const error = new Error('Слишком частые запросы. Попробуйте позже.'); error.definite = true; throw error;
}
async function reconcile(body) {
  if (!body.request_id) return null;
  try {
    await pace();
    const response = await fetch('/api/v1/operations?request_id=' + encodeURIComponent(body.request_id));
    if (!response.ok) return null;
    const operation = await response.json();
    return ['succeeded', 'failed'].includes(operation.status) ? operation : null;
  } catch { return null; }
}
document.addEventListener('submit', async event => {
  const form = event.target; if (!(form instanceof HTMLFormElement)) return;
  if (!form.dataset.action) { event.preventDefault(); await pace(); location.assign(form.action.split('?')[0] + '?' + new URLSearchParams(new FormData(form))); return; }
  event.preventDefault(); const button = form.querySelector('button'); if (button.disabled) return; button.disabled = true; feedback('Сохраняем…');
  const data = Object.fromEntries(new FormData(form)); const request_id = crypto.randomUUID(); let path, body, destination = location.pathname;
  try {
    switch (form.dataset.action) {
      case 'login': path = '/login'; body = data; destination = '/'; break;
      case 'logout': path = '/logout'; body = {}; destination = '/login'; break;
      case 'candidate': case 'edit-company': path = '/api/v1/candidates'; body = { name: data.name, ...(data.website ? { website: data.website } : {}), sources: [source(data)], rationale: data.rationale, request_id, ...(form.dataset.action === 'edit-company' ? { company_id: form.dataset.id, expected_version: Number(form.dataset.version) } : {}) }; destination = '/'; break;
      case 'resolve': path = '/api/v1/candidates/resolve'; body = { candidate_id: form.dataset.id, expected_version: Number(form.dataset.version), request_id, ...(data.company_id ? { company_id: data.company_id } : {}) }; destination = '/'; break;
      case 'contact': path = '/api/v1/contacts'; body = { company_id: form.dataset.id, email: data.email, ...(data.name ? { name: data.name } : {}), source: source(data), verified_at: new Date().toISOString(), request_id }; break;
      case 'opportunity': path = '/api/v1/opportunities'; body = { company_id: form.dataset.id, subject: data.subject, sources: [source(data)], rationale: data.rationale, request_id }; break;
      case 'status': path = '/api/v1/opportunities/status'; body = { opportunity_id: form.dataset.id, expected_version: Number(form.dataset.version), request_id, status: data.status, ...(data.next_step ? { next_step: data.next_step } : {}), ...(data.next_step_at ? { next_step_at: new Date(data.next_step_at + 'Z').toISOString() } : {}), ...(data.reason ? { reason: data.reason, ...(data.status === 'deferred' ? { deferred_reason: data.reason } : {}) } : {}), ...(data.agreement ? { agreement: data.agreement } : {}) }; break;
      case 'mail-draft': path = '/api/v1/mail/draft'; body = { opportunity_id: form.dataset.id, ...(form.dataset.proposal ? {proposal_id:form.dataset.proposal,expected_version:Number(form.dataset.version)} : {}), from:data.from,reply_to:data.reply_to,to:data.to,subject:data.subject,body:data.body,basis:'self_test',request_id }; break;
      case 'mail-submit': path = '/api/v1/mail/submit'; body = { proposal_id:form.dataset.id,expected_version:Number(form.dataset.version),request_id }; break;
      case 'mail-approve': case 'mail-queue': path = '/api/v1/mail/' + (form.dataset.action === 'mail-approve' ? 'approve' : 'queue'); body = { proposal_id:form.dataset.id,expected_version:Number(form.dataset.version),content_hash:form.dataset.hash,request_id }; break;
      case 'mail-revoke': path = '/api/v1/mail/revoke'; body = { proposal_id:form.dataset.id,request_id }; break;
      case 'mail-close-unknown': path = '/api/v1/mail/close-unknown'; body = { proposal_id:form.dataset.id,note:data.note,request_id }; break;
      case 'mail-pause': case 'mail-resume': path = '/api/v1/mail/pause'; body = { paused:form.dataset.action === 'mail-pause',request_id }; break;
      case 'mail-suppress': path = '/api/v1/mail/suppress'; body = { email:data.email,reason:data.reason,request_id }; break;
      case 'mail-probe': path = '/api/v1/mail/probe'; body = {}; break;
      default: throw new Error('Действие недоступно');
    }
    const answer = await request(path, body);
    if (form.dataset.action === 'mail-probe') { feedback(answer.ready ? 'SMTP: TLS, авторизация и отправитель проверены; письмо не отправлено.' : 'Проверка SMTP не пройдена. Письмо не отправлено.'); button.disabled = false; return; }
    feedback('Сохранено'); await pace(); location.assign(destination);
  } catch (error) {
    if (body?.request_id && !error.definite) {
      const operation = await reconcile(body);
      if (operation?.status === 'succeeded') { feedback('Сохранение подтверждено'); await pace(); location.assign(destination); return; }
      if (operation?.status === 'failed') { feedback('Операция не выполнена: ' + operation.error.code); button.disabled = false; return; }
      feedback('Сохранение не подтверждено. Проверьте реестр перед новым действием. Номер операции: ' + body.request_id + '. ' + (error.message || 'Связь прервана.'));
      // Do not retry an uncertain mutation with a fresh request_id.
      button.disabled = true;
    } else { feedback(error.message || 'Связь прервана. Попробуйте позже.'); button.disabled = false; }
  }
});
document.addEventListener('click', async event => { const link = event.target.closest('a'); if (!link || link.target || event.ctrlKey || event.metaKey || event.shiftKey || !link.getAttribute('href').startsWith('/')) return; event.preventDefault(); await pace(); location.assign(link.href); });`;
