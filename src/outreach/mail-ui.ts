const e=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

export type MailCard = {opportunity_id:string;proposal:Record<string,unknown>;
  versions:Array<Record<string,unknown>>; approvals:Array<Record<string,unknown>>;
  jobs:Array<Record<string,unknown>>; replies:Array<Record<string,unknown>>;
  events:Array<Record<string,unknown>>; mail_enabled:boolean; paused:boolean};
const date=(value:unknown)=>value ? e(new Date(String(value)).toLocaleString('ru-RU',{timeZone:'UTC'})) : '—';
function action(name:string,label:string,p:Record<string,unknown>,v:Record<string,unknown>,extra='') {
  return `<form data-action="${name}" data-id="${e(p.id)}" data-version="${e(p.current_version)}" data-hash="${e(v.content_hash)}">${extra}<button>${label}</button></form>`;
}
function draft(opportunityId:string,p?:Record<string,unknown>,v?:Record<string,unknown>) {
  return `<form data-action="mail-draft" data-id="${e(opportunityId)}" data-proposal="${e(p?.id??'')}" data-version="${e(p?.current_version??'')}">
    <label>От<input name="from" type="email" value="${e(v?.from_email??'info@ycs.bar')}" required></label>
    <label>Ответить<input name="reply_to" type="email" value="${e(v?.reply_to??'info@ycs.bar')}" required></label>
    <label>Кому<input name="to" type="email" value="${e(v?.to_email??'r.talyutin@gmail.com')}" required></label>
    <label>Тема<input name="subject" maxlength="300" value="${e(v?.subject??'')}" required></label>
    <label>Полный текст<textarea name="body" maxlength="20000" required>${e(v?.body??'')}</textarea></label>
    <button>${p ? 'Сохранить новую версию' : 'Сохранить черновик'}</button></form>`;
}

function replyHistory(card?:MailCard) {
  const groups=(card?.jobs??[]).map(job=>({job,replies:(card?.replies??[]).filter(reply=>reply.job_id===job.id)}))
    .filter(group=>group.replies.length);
  if (!groups.length) return '';
  return `<details><summary>Ответы (${groups.reduce((count,group)=>count+group.replies.length,0)})</summary>
    ${groups.map(({job,replies})=>{
      const original=card?.versions.find(version=>version.version===job.version);
      return `<section><p><b>Исходящее письмо:</b> версия ${e(job.version??'—')} · ${e(original?.subject??'')}
        <br>Message-ID: ${e(job.message_id)} · ${e(job.status)}</p>
        ${replies.map(reply=>`<article><p><b>От:</b> ${e(reply.from_email)} · ${date(reply.received_at)}<br><b>Тема:</b> ${e(reply.subject)}</p>
          <pre class="mail-body">${e(reply.body)}</pre>${reply.truncated?'<p>Полный текст и вложения доступны в почте Timeweb.</p>':''}
          <small>Message-ID ответа: ${e(reply.received_message_id??'—')}</small></article>`).join('')}</section>`;
    }).join('')}</details>`;
}

/** Same server-rendered card as the existing registry. No outgoing action appears for MCP clients. */
export function mailSections(opportunities:Array<Record<string,unknown>>,mail:MailCard[]):string {
  return `<section class="panel"><h2>Контрольные письма</h2><p>Исходящий тест: info@ycs.bar → r.talyutin@gmail.com. Одобрение и постановка в очередь — два отдельных действия.</p>
    ${mail.length ? `<p>Транспорт: ${mail[0].mail_enabled ? 'включён' : 'выключен'} · пауза: ${mail[0].paused ? 'да' : 'нет'}</p>` : ''}
    <div class="mail-actions"><form data-action="mail-probe"><button>Проверить SMTP без письма</button></form>
    <form data-action="mail-pause"><button>Пауза</button></form><form data-action="mail-resume"><button>Снять паузу</button></form></div>
    ${opportunities.map(opportunity=>{
      const card=mail.find(item=>item.opportunity_id===opportunity.id);
      const p=card?.proposal,v=card?.versions[0],job=card?.jobs[0];
      return `<article class="opportunity"><h3>${e(opportunity.subject)}</h3>
        ${v && p ? `<p><b>От:</b> ${e(v.from_email)}<br><b>Кому:</b> ${e(v.to_email)}<br><b>Ответить:</b> ${e(v.reply_to)}<br><b>Тема:</b> ${e(v.subject)}</p>
          <p>Версия ${e(v.version)} · состояние ${e(p.state)} · SHA-256 ${e(v.content_hash)}</p><pre class="mail-body">${e(v.body)}</pre>
          <div class="mail-actions">${p.state==='draft' ? action('mail-submit','Отправить на рассмотрение',p,v) : ''}
          ${p.state==='awaiting_approval' ? action('mail-approve','Одобрить эту версию',p,v) : ''}
          ${p.state==='approved' && !job ? action('mail-queue','Поставить в очередь',p,v) : ''}
          ${p.state==='approved' && (!job || job.status==='queued') ? action('mail-revoke','Отозвать одобрение',p,v) : ''}</div>
          ${job ? `<p><b>Отправка:</b> ${e(job.status)} · код SMTP ${e(job.smtp_code??'—')} · ${e(job.failure_code??'—')}</p>
            <small>Message-ID: ${e(job.message_id)} · attempt_id: ${e(job.attempt_id??'не начата')} · ${date(job.attempt_started_at)}</small>
            ${job.status==='unknown' && !job.resolution ? action('mail-close-unknown','Закрыть без повтора',p,v,'<label>Причина проверки<textarea name="note" required maxlength="2000"></textarea></label>') : ''}
            ${job.resolution ? `<p>Разбор закрыт без повтора: ${e(job.resolution_note)}</p>` : ''}` : ''}
          ${replyHistory(card)}
          ${!job || ['queued','paused','cancelled','failed'].includes(String(job.status)) ? `<details><summary>Новая версия письма</summary>${draft(String(opportunity.id),p,v)}</details>` : '<p>Для начатой или неопределённой отправки изменение этой версии закрыто.</p>'}
          <details><summary>История письма</summary><ul>${card?.events.map(event=>`<li>${date(event.created_at)} · ${e(event.action)} · ${e(event.actor_id)}</li>`).join('')??''}</ul></details>`
          : `<p class="muted">Черновика пока нет.</p>${draft(String(opportunity.id))}`}</article>`;
    }).join('')}
    <details><summary>Запретить дальнейший контакт</summary><form data-action="mail-suppress">
      <label>Адрес<input name="email" type="email" required></label><label>Причина<input name="reason" maxlength="2000" required></label>
      <button>Сохранить запрет</button></form></details>
    </section>`;
}
