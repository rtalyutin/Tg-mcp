import { TelegramReadinessChecker, TelegramSender } from '../src/telegram.ts';
import { CHANNEL_DESTINATION_PATTERN, TASK_ID_PATTERN } from '../src/publisher.ts';
import { createHash } from 'node:crypto';

const origin = process.env.YCS_ORIGIN;
const token = process.env.YCS_WORKER_TOKEN;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!origin || !token || !botToken || new URL(origin).protocol !== 'https:' ||
    new URL(origin).username || new URL(origin).password || new URL(origin).search || new URL(origin).hash ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('WORKER_CONFIG_INVALID');
const base = new URL(origin);
const checker = new TelegramReadinessChecker({botToken});
const sender = new TelegramSender({botToken});
type Reply = Record<string, unknown>;
async function call(action: string, body: object): Promise<Reply> {
  const response = await fetch(new URL('/internal/telegram/' + action, base), {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(20_000),
    headers:{authorization:'Bearer ' + token, 'content-type':'application/json'},
    body:JSON.stringify(body),
  });
  if (response.status !== 200) throw new Error('WORKER_API_' + response.status);
  const result = await response.json();
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('WORKER_RESPONSE_INVALID');
  return result as Reply;
}
const routes = (await call('routes', {})).routes;
if (!Array.isArray(routes) || routes.length === 0 || routes.length > 32) throw new Error('ROUTES_INVALID');
const verified = new Map<string,string>();
for (const route of routes) {
  if (!route || typeof route !== 'object' || typeof route.task_id !== 'string' ||
      typeof route.channel_id !== 'string' || (route.task_id !== '' && !TASK_ID_PATTERN.test(route.task_id)) ||
      !CHANNEL_DESTINATION_PATTERN.test(route.channel_id)) throw new Error('ROUTE_INVALID');
  const check = await checker.check(route.channel_id, true);
  await call('check', {task_id:route.task_id, ready:check.ready, check_code:check.ready ? null : check.check_code ?? 'TELEGRAM_NOT_READY'});
  if (check.ready) verified.set(route.task_id, check.resolved_channel_id ?? route.channel_id);
}
console.log('WORKER_CHECKED routes=' + routes.length + ' ready=' + verified.size);
if (verified.size !== routes.length) process.exitCode = 1;
else {
  // Bounded run. A subsequent scheduled/manual invocation drains the rest.
  for (let count = 0; count < 30; count++) {
    const job = await call('claim', {});
    if (job.status === 'empty' || job.code === 'PUBLISH_DISABLED') break;
    if (job.status !== 'claimed' || typeof job.attempt_id !== 'string' ||
        typeof job.lease_id !== 'string' || typeof job.task_id !== 'string' ||
        typeof job.channel_id !== 'string' || !['text','photo'].includes(String(job.kind)) ||
        !Number.isSafeInteger(job.part_index)) throw new Error('CLAIM_INVALID');
    let photo: Buffer | undefined;
    if (job.kind === 'photo') {
      if (job.mime_type !== 'image/png' || typeof job.image_base64 !== 'string' || typeof job.sha256 !== 'string' ||
          job.image_base64.length > 10 * 1024 * 1024) throw new Error('COVER_INVALID');
      photo = Buffer.from(job.image_base64, 'base64');
      if (createHash('sha256').update(photo).digest('hex') !== job.sha256 || photo.toString('base64') !== job.image_base64)
        throw new Error('COVER_INVALID');
    } else if (typeof job.text !== 'string') throw new Error('CLAIM_INVALID');
    // Recheck rights immediately before each send. Never trust a stale heartbeat.
    const ready = await checker.check(job.channel_id, true);
    const numeric = ready.ready ? ready.resolved_channel_id ?? job.channel_id : undefined;
    if (!numeric || numeric !== verified.get(job.task_id)) {
      await call('defer', {attempt_id:job.attempt_id, lease_id:job.lease_id,
        code:ready.ready ? 'CHANNEL_ID_CHANGED' : ready.check_code ?? 'TELEGRAM_NOT_READY'});
      console.log('WORKER_DEFERRED');
      break;
    }
    const begun = await call('begin', {attempt_id:job.attempt_id,lease_id:job.lease_id,resolved_channel_id:numeric});
    if (begun.status !== 'ready') {
      console.log('WORKER_BEGIN_DENIED');
      break;
    }
    const outcome = photo ? await sender.sendPhoto(numeric, photo) : await sender.send(numeric, job.text as string);
    const completed = await call('complete', {attempt_id:job.attempt_id,lease_id:job.lease_id,outcome});
    if (completed.status === 'QUEUED' || completed.status === 'PUBLISHED') console.log('WORKER_CONFIRMED part=' + job.part_index);
    else { console.log('WORKER_STOPPED status=' + (typeof completed.status === 'string' ? completed.status : 'UNKNOWN')); break; }
    if (completed.status === 'QUEUED') await new Promise(resolve => setTimeout(resolve, 1200));
  }
}
