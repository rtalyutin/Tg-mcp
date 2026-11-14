import registry from '../src/data/teams.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import baseline from '../src/data/tournaments/cs2-lce-november-2026.json' with { type: 'json' };
import { deriveLce, lceFixtures, validateLceResult, lceFail } from '../src/lib/lce-tournament.js';
import { exactStart } from '../src/lib/community.js';
import { createMatchMediaS3Store } from './match-media-store.mjs';
export const emptyLce = () => ({ schemaVersion: 1, revision: 0, updatedAt: null, matches: {}, slots: {}, draws: {}, requests: {} });
export function validateLceDocument(doc) {
  if (!doc || doc.schemaVersion !== 1 || !Number.isSafeInteger(doc.revision) || doc.revision < 0 ||
    !['matches', 'slots', 'draws', 'requests'].every(k => doc[k] && typeof doc[k] === 'object' && !Array.isArray(doc[k])) ||
    (doc.revision > 0 && !Number.isFinite(Date.parse(doc.updatedAt)))) lceFail('Хранилище результатов повреждено', 503);
  if (Object.keys(doc).some(k => !['schemaVersion', 'revision', 'updatedAt', 'matches', 'slots', 'draws', 'requests'].includes(k)) ||
      Object.entries(doc.requests).some(([id, receipt]) => !/^[a-f0-9]{32}$/.test(id) || !receipt || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > doc.revision) ||
      Object.values(doc.slots).some(slot => !exactStart(slot))) lceFail('Хранилище результатов повреждено', 503);
  deriveLce(baseline, doc, registry); return doc;
}
export function createLceResultsService({ env = process.env, store = createMatchMediaS3Store({ env, key: 'results/cs2-lce-november-2026.json', validate: validateLceDocument, empty: emptyLce }), now = Date.now } = {}) {
  return { async read() { const { value } = await store.read(); return deriveLce(baseline, value, registry); },
    async organizer(body = null) {
      const previous = await store.read();
      if (body === null) return deriveLce(baseline, previous.value, registry);
      if (!body || Array.isArray(body) || Object.keys(body).some(k => !['action', 'requestId', 'expectedRevision', 'matchId', 'result', 'scheduledAt', 'teamIds'].includes(k)) ||
        !/^[a-f0-9]{32}$/.test(body.requestId || '') || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) lceFail('Неверный запрос');
      const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const receipt = previous.value.requests[body.requestId];
      if (receipt) { if (receipt.fingerprint !== fingerprint) lceFail('Повторный запрос содержит другие данные', 409); return deriveLce(baseline, previous.value, registry); }
      if (body.expectedRevision !== previous.value.revision) lceFail('Результаты изменились в другой вкладке. Обновите список', 409);
      const before = deriveLce(baseline, previous.value, registry), fixtures = lceFixtures(before.tournament);
      const match = fixtures.find(m => m.id === body.matchId);
      const value = structuredClone(previous.value);
      if (body.action === 'result') {
        if (!match) lceFail('Матч не найден', 404);
        const result = validateLceResult(match, body.result);
        value.matches[match.id] = { ...result, team1Id: match.team1Id, team2Id: match.team2Id };
      } else if (body.action === 'slot') {
        if (!match?.id.startsWith('lce-tb-') || !exactStart(body.scheduledAt) || Date.parse(body.scheduledAt) < Date.parse('2026-11-14T22:30:00+03:00')) lceFail('Укажите время тай-брейка не раньше 22:30 МСК');
        if (fixtures.some(m => m.id !== match.id && m.scheduledAt && [m.team1Id, m.team2Id].some(id => [match.team1Id, match.team2Id].includes(id)) && Date.parse(m.scheduledAt) === Date.parse(body.scheduledAt))) lceFail('Матчи одной команды нужно назначить на разные слоты');
        value.slots[match.id] = body.scheduledAt;
      } else if (body.action === 'draw') {
        const ids = body.teamIds;
        if (!Array.isArray(ids) || ids.length < 2 || new Set(ids).size !== ids.length || !ids.every(id => baseline.participants.some(p => p.teamId === id)) || !before.unresolved.includes([...ids].sort().join('|'))) lceFail('Жребий допустим только для оставшегося равенства после тай-брейков');
        value.draws[[...ids].sort().join('|')] = ids;
      } else lceFail('Неизвестная операция');
      value.revision++; value.updatedAt = new Date(now()).toISOString();
      value.requests[body.requestId] = { fingerprint, revision: value.revision };
      if (Object.keys(value.requests).length > 8192) lceFail('Лимит операций хранилища', 503);
      deriveLce(baseline, value, registry); // Reject changes to any saved dependent fixture before committing.
      const saved = await store.compareAndSet(previous, value, body.requestId);
      return deriveLce(baseline, saved.value, registry);
    } };
}
export function createLcePublicHandler({ service, env = process.env }) {
  return async (request, response, url) => {
    if (url.pathname !== '/api/tournaments/cs2-lce-november-2026') return false;
    const origin = request.headers.origin, allowed = env.YCS_ORGS_ALLOWED_ORIGIN || 'https://xn--90aiaibl0ahlel5n.xn--p1ai';
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body)); return true; };
    if (origin && origin !== allowed) return send(403, { error: 'origin_denied' });
    if (origin) { response.setHeader('access-control-allow-origin', origin); response.setHeader('vary', 'Origin'); }
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, { error: 'method_not_allowed' });
    try { return send(200, await service.read()); } catch { return send(503, { error: 'Результаты временно недоступны' }); }
  };
}
