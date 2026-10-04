import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { telegramCollectorMigrationSql } from './schema.ts';

type RecordValue = Record<string, unknown>;
type Connection = { id: string; ownerId: string; isEnabled: boolean };
type Direction = 'incoming' | 'outgoing' | 'unknown';
type EventKind = 'created' | 'edited' | 'deleted';
export type TelegramJournalEvent = {
  seq: string; event_id: string; bot_id: string; owner_id: string; update_id: string; update_fingerprint: string;
  event_kind: EventKind; connection_id: string; chat_id: string; message_id: string; source_message_id: string;
  sender_id: string | null; sender_business_bot_id: string | null; direction: Direction; text: string | null;
  media_kind: string | null; media_file_unique_id: string | null; message_at: string | null; edit_at: string | null;
  event_at: string; event_time_basis: 'message' | 'edit' | 'observed'; received_at: string; deletion_content_known: boolean;
};
export type TelegramCollectorStatus = {
  bot_id: string; owner_id: string; next_offset: number | null; started_at: string; last_update_at: string | null;
  last_response_at: string | null; last_poll_at: string | null; last_error_code: string | null;
  events_count: string; snapshot_max_seq: string;
  connections: { id: string; is_enabled: boolean; updated_at: string }[];
  polling_gaps: { started_at: string; ended_at: string; retention_risk: boolean }[]; gaps_has_more: boolean;
};
type Message = {
  chatId: string; messageId: string; senderId: string | null; senderBusinessBotId: string | null; direction: Direction;
  text: string | null; mediaKind: string | null; mediaFileUniqueId: string | null;
  messageAt: Date | null; editAt: Date | null;
};

function invalid(code = 'TELEGRAM_EVENT_INVALID'): never { throw Object.assign(new Error(code), { code }); }
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as RecordValue;
}
function numericId(value: unknown, signed = false, zero = false): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (!signed && value < (zero ? 0 : 1))) invalid();
  return String(value);
}
function configId(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) invalid('TELEGRAM_ID_CONFIGURATION_INVALID');
  return value;
}
function connectionId(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function unixDate(value: unknown): Date {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000) invalid();
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) invalid();
  return date;
}
function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return value;
}
function normalizeConnection(value: unknown): Connection {
  const object = record(value);
  if (typeof object.is_enabled !== 'boolean') invalid('TELEGRAM_CONNECTION_INVALID');
  return { id: connectionId(object.id), ownerId: numericId(record(object.user).id), isEnabled: object.is_enabled };
}
function nullableText(value: unknown, maxLength = 32_768): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > maxLength || value.includes('\u0000')) invalid();
  return value;
}
function media(object: RecordValue): { kind: string | null; uniqueId: string | null } {
  for (const kind of ['photo', 'video', 'animation', 'audio', 'document', 'voice', 'video_note', 'sticker']) {
    if (object[kind] === undefined) continue;
    const value = kind === 'photo' ? (Array.isArray(object.photo) ? object.photo.at(-1) : invalid()) : object[kind];
    const metadata = record(value);
    return { kind, uniqueId: nullableText(metadata.file_unique_id, 512) };
  }
  for (const kind of ['location', 'venue', 'contact', 'poll', 'dice', 'paid_media']) {
    if (object[kind] !== undefined) { record(object[kind]); return { kind, uniqueId: null }; }
  }
  for (const kind of ['live_photo', 'rich_message']) {
    if (object[kind] !== undefined) return { kind, uniqueId: null };
  }
  return { kind: null, uniqueId: null };
}
function normalizeMessage(value: unknown, ownerId: string): Message {
  const object = record(value);
  const senderId = object.from === undefined ? null : numericId(record(object.from).id);
  const senderBusinessBot = object.sender_business_bot === undefined ? null : record(object.sender_business_bot);
  if (senderBusinessBot && senderBusinessBot.is_bot !== true) invalid();
  const senderBusinessBotId = senderBusinessBot ? numericId(senderBusinessBot.id) : null;
  if (object.sender_chat !== undefined) numericId(record(object.sender_chat).id, true);
  const metadata = media(object);
  if (object.text !== undefined && object.caption !== undefined) invalid();
  const editAt = object.edit_date === undefined ? null : unixDate(object.edit_date);
  return {
    chatId: numericId(record(object.chat).id, true), messageId: numericId(object.message_id, false, true),
    senderId, senderBusinessBotId, direction: senderBusinessBotId !== null ? 'outgoing'
      : object.sender_chat !== undefined || senderId === null ? 'unknown' : senderId === ownerId ? 'outgoing' : 'incoming',
    text: nullableText(object.text ?? object.caption), mediaKind: metadata.kind, mediaFileUniqueId: metadata.uniqueId,
    messageAt: unixDate(object.date), editAt,
  };
}
function iso(value: unknown): string | null {
  if (value == null) return null;
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}
function seqValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) invalid('TELEGRAM_READ_INPUT_INVALID');
  return value;
}
function fingerprint(value: unknown): string {
  // Canonical JSON ignores object key order; arrays retain their source order. No raw update is stored.
  function canonical(input: unknown): unknown {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') { if (!Number.isFinite(input)) invalid(); return input; }
    if (Array.isArray(input)) return input.map(canonical);
    const object = record(input);
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])]));
  }
  try { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
  catch { invalid(); }
}

/** Durable replay-tolerant journal. Offset advancement commits with the complete batch. */
export class TelegramEventStore {
  readonly pool: Pool;
  readonly botId: string;
  readonly ownerTelegramId: string;

  constructor(pool: Pool, botId: string, ownerTelegramId: string) {
    this.pool = pool; this.botId = configId(botId); this.ownerTelegramId = configId(ownerTelegramId);
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('telegram-collector-migrations'))");
      await client.query('CREATE SCHEMA IF NOT EXISTS telegram_collector');
      await client.query(`CREATE TABLE IF NOT EXISTS telegram_collector.schema_version (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL)`);
      const version = await client.query('SELECT version FROM telegram_collector.schema_version WHERE singleton = true');
      if (version.rows.length && version.rows[0].version !== 1) invalid('UNSUPPORTED_TELEGRAM_COLLECTOR_SCHEMA');
      if (!version.rows.length) {
        await client.query(telegramCollectorMigrationSql);
        await client.query('INSERT INTO telegram_collector.schema_version(singleton, version) VALUES(true, 1)');
      }
      await client.query('INSERT INTO telegram_collector.state(bot_id, owner_id) VALUES($1, $2) ON CONFLICT DO NOTHING', [this.botId, this.ownerTelegramId]);
      const state = await client.query('SELECT owner_id FROM telegram_collector.state WHERE bot_id = $1', [this.botId]);
      if (state.rows[0]?.owner_id !== this.ownerTelegramId) invalid('TGC_OWNER_MISMATCH');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async getCheckpoint(): Promise<{ nextOffset: number | null; lastUpdateAt: Date | null }> {
    await this.assertOwner();
    const result = await this.pool.query(`SELECT next_offset, last_update_at FROM telegram_collector.state
      WHERE bot_id = $1 AND owner_id = $2`, [this.botId, this.ownerTelegramId]);
    if (!result.rows.length) invalid('TELEGRAM_STORE_NOT_INITIALIZED');
    return { nextOffset: result.rows[0].next_offset == null ? null : Number(result.rows[0].next_offset),
      lastUpdateAt: result.rows[0].last_update_at == null ? null : new Date(result.rows[0].last_update_at) };
  }

  async getConnection(id: string): Promise<Connection | null> {
    await this.assertOwner();
    const result = await this.pool.query(`SELECT connection_id, owner_id, is_enabled FROM telegram_collector.connections
      WHERE bot_id = $1 AND connection_id = $2`, [this.botId, connectionId(id)]);
    const row = result.rows[0];
    return row ? { id: row.connection_id, ownerId: row.owner_id, isEnabled: row.is_enabled } : null;
  }

  async ingestBatch(updates: unknown[], connections: unknown[], receivedAt = new Date()): Promise<void> {
    validDate(receivedAt);
    if (!Array.isArray(updates) || !Array.isArray(connections) || updates.length > 100 || connections.length > 200) invalid();
    const preparedConnections = connections.map(normalizeConnection);
    const preparedUpdates = updates.map(value => {
      const object = record(value);
      const id = Number(numericId(object.update_id, false, true));
      if (id >= Number.MAX_SAFE_INTEGER) invalid();
      const relevant = ['business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'].filter(key => object[key] !== undefined);
      if (relevant.length > 1) invalid();
      return { object, id, fingerprint: fingerprint(object), relevant: relevant[0] };
    }).sort((a, b) => a.id - b.id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT owner_id FROM telegram_collector.state WHERE bot_id = $1 FOR UPDATE`, [this.botId]);
      if (!locked.rows.length) invalid('TELEGRAM_STORE_NOT_INITIALIZED');
      if (locked.rows[0].owner_id !== this.ownerTelegramId) invalid('TGC_OWNER_MISMATCH');
      for (const connection of preparedConnections) await this.saveConnection(client, connection, receivedAt, false);
      for (const update of preparedUpdates) {
        const inserted = await client.query(`INSERT INTO telegram_collector.updates(bot_id, update_id, update_fingerprint, received_at)
          VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING update_id`, [this.botId, update.id, update.fingerprint, receivedAt]);
        if (!inserted.rows.length || !update.relevant) continue;
        if (update.relevant === 'business_connection') {
          await this.saveConnection(client, normalizeConnection(update.object.business_connection), receivedAt, true);
          continue;
        }
        const payload = record(update.object[update.relevant]);
        const id = connectionId(payload.business_connection_id);
        const found = await client.query(`SELECT owner_id, is_enabled FROM telegram_collector.connections
          WHERE bot_id = $1 AND connection_id = $2`, [this.botId, id]);
        if (!found.rows.length) invalid('TELEGRAM_CONNECTION_UNKNOWN');
        // Do not parse, persist, or log any message content belonging to another owner.
        if (found.rows[0].owner_id !== this.ownerTelegramId) continue;
        const chat = record(payload.chat);
        if (chat.type !== 'private') {
          if (['group', 'supergroup', 'channel'].includes(String(chat.type))) continue;
          invalid();
        }
        if (update.relevant === 'deleted_business_messages') {
          const chatId = numericId(record(payload.chat).id, true);
          if (!Array.isArray(payload.message_ids) || !payload.message_ids.length || payload.message_ids.length > 1000) invalid();
          const messageIds = [...new Set(payload.message_ids.map(value => numericId(value, false, true)))];
          for (const messageId of messageIds) {
            const previous = await client.query(`SELECT * FROM telegram_collector.messages
              WHERE bot_id = $1 AND owner_id = $2 AND connection_id = $3 AND chat_id = $4 AND message_id = $5`,
              [this.botId, this.ownerTelegramId, id, chatId, messageId]);
            const row = previous.rows[0];
            const message: Message = row ? { chatId, messageId, senderId: row.sender_id, senderBusinessBotId: row.sender_business_bot_id, direction: row.direction,
              text: row.text, mediaKind: row.media_kind, mediaFileUniqueId: row.media_file_unique_id,
              messageAt: row.message_at == null ? null : new Date(row.message_at), editAt: row.edit_at == null ? null : new Date(row.edit_at) }
              : { chatId, messageId, senderId: null, senderBusinessBotId: null, direction: 'unknown', text: null, mediaKind: null, mediaFileUniqueId: null, messageAt: null, editAt: null };
            await this.saveEvent(client, update.id, update.fingerprint, 'deleted', id, message, receivedAt, Boolean(row));
          }
        } else {
          const kind: EventKind = update.relevant === 'business_message' ? 'created' : 'edited';
          await this.saveEvent(client, update.id, update.fingerprint, kind, id, normalizeMessage(payload, this.ownerTelegramId), receivedAt, false);
        }
      }
      if (preparedUpdates.length) await client.query(`UPDATE telegram_collector.state SET next_offset = $3, last_update_at = $4
        WHERE bot_id = $1 AND owner_id = $2`, [this.botId, this.ownerTelegramId, preparedUpdates.at(-1)!.id + 1, receivedAt]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async saveConnection(client: PoolClient, connection: Connection, receivedAt: Date, replace: boolean): Promise<void> {
    await client.query(`INSERT INTO telegram_collector.connections(bot_id, connection_id, owner_id, is_enabled, updated_at)
      VALUES($1, $2, $3, $4, $5) ON CONFLICT(bot_id, connection_id) ${replace
        ? 'DO UPDATE SET owner_id = EXCLUDED.owner_id, is_enabled = EXCLUDED.is_enabled, updated_at = EXCLUDED.updated_at'
        : 'DO NOTHING'}`, [this.botId, connection.id, connection.ownerId, connection.isEnabled, receivedAt]);
  }

  private async saveEvent(client: PoolClient, updateId: number, updateFingerprint: string, kind: EventKind, connection: string,
    message: Message, receivedAt: Date, contentKnown: boolean): Promise<void> {
    const sourceId = `telegram:${this.botId}:${encodeURIComponent(connection)}:${message.chatId}:${message.messageId}`;
    const eventId = `${sourceId}:${updateId}:${updateFingerprint}:${kind}`;
    const eventAt = kind === 'deleted' ? receivedAt : kind === 'edited' ? message.editAt ?? receivedAt : message.messageAt!;
    const result = await client.query(`INSERT INTO telegram_collector.events(event_id, bot_id, owner_id, update_id, update_fingerprint, event_kind,
      connection_id, chat_id, message_id, source_message_id, sender_id, sender_business_bot_id, direction, text, media_kind, media_file_unique_id,
      message_at, edit_at, event_at, event_time_basis, received_at, deletion_content_known)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT DO NOTHING RETURNING seq`, [eventId, this.botId, this.ownerTelegramId, updateId, updateFingerprint, kind, connection,
      message.chatId, message.messageId, sourceId, message.senderId, message.senderBusinessBotId, message.direction, message.text, message.mediaKind,
      message.mediaFileUniqueId, message.messageAt, message.editAt, eventAt,
      kind === 'deleted' || (kind === 'edited' && message.editAt === null) ? 'observed' : kind === 'edited' ? 'edit' : 'message', receivedAt, contentKnown]);
    if (!result.rows.length) return;
    await client.query(`INSERT INTO telegram_collector.messages(bot_id, owner_id, connection_id, chat_id, message_id,
      source_message_id, sender_id, sender_business_bot_id, direction, text, media_kind, media_file_unique_id, message_at, edit_at, is_deleted, latest_seq)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT(bot_id, connection_id, chat_id, message_id) DO UPDATE SET sender_id=EXCLUDED.sender_id,
      sender_business_bot_id=EXCLUDED.sender_business_bot_id, direction=EXCLUDED.direction, text=EXCLUDED.text, media_kind=EXCLUDED.media_kind,
      media_file_unique_id=EXCLUDED.media_file_unique_id, message_at=EXCLUDED.message_at, edit_at=EXCLUDED.edit_at,
      is_deleted=EXCLUDED.is_deleted, latest_seq=EXCLUDED.latest_seq`, [this.botId, this.ownerTelegramId, connection,
      message.chatId, message.messageId, sourceId, message.senderId, message.senderBusinessBotId, message.direction, message.text, message.mediaKind,
      message.mediaFileUniqueId, message.messageAt, message.editAt, kind === 'deleted', result.rows[0].seq]);
  }

  /** Successful Telegram response is observable even if later validation/commit fails; no offset acknowledgement. */
  async markResponse(at = new Date()): Promise<void> {
    validDate(at);
    await this.assertOwner();
    await this.pool.query(`UPDATE telegram_collector.state SET last_response_at = $3
      WHERE bot_id = $1 AND owner_id = $2`, [this.botId, this.ownerTelegramId, at]);
  }

  async markPoll(errorCode: string | null, at = new Date()): Promise<void> {
    validDate(at);
    if (errorCode !== null && !/^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode)) invalid('TELEGRAM_ERROR_CODE_INVALID');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const state = await client.query(`SELECT owner_id, last_poll_at FROM telegram_collector.state
        WHERE bot_id = $1 FOR UPDATE`, [this.botId]);
      if (!state.rows.length) invalid('TELEGRAM_STORE_NOT_INITIALIZED');
      if (state.rows[0].owner_id !== this.ownerTelegramId) invalid('TGC_OWNER_MISMATCH');
      const previous = state.rows[0].last_poll_at == null ? null : new Date(state.rows[0].last_poll_at);
      if (errorCode === null && previous && at.getTime() - previous.getTime() > 90_000) {
        await client.query(`INSERT INTO telegram_collector.polling_gaps(bot_id, started_at, ended_at, retention_risk)
          VALUES($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [this.botId, previous, at, at.getTime() - previous.getTime() >= 86_400_000]);
      }
      await client.query(`UPDATE telegram_collector.state SET last_error_code = $3,
        last_poll_at = CASE WHEN $3::text IS NULL THEN $4 ELSE last_poll_at END WHERE bot_id = $1 AND owner_id = $2`,
        [this.botId, this.ownerTelegramId, errorCode, at]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async readStatus(from?: string, to?: string): Promise<TelegramCollectorStatus> {
    await this.assertOwner();
    const windowFrom = from === undefined ? null : new Date(from);
    const windowTo = to === undefined ? null : new Date(to);
    if ((windowFrom === null) !== (windowTo === null) || (windowFrom && windowTo &&
      (!Number.isFinite(windowFrom.getTime()) || !Number.isFinite(windowTo.getTime()) || windowFrom >= windowTo))) invalid('TELEGRAM_READ_INPUT_INVALID');
    const state = await this.pool.query(`SELECT bot_id, owner_id, next_offset, started_at, last_update_at, last_response_at, last_poll_at, last_error_code
      FROM telegram_collector.state WHERE bot_id = $1 AND owner_id = $2`, [this.botId, this.ownerTelegramId]);
    if (!state.rows.length) invalid('TELEGRAM_STORE_NOT_INITIALIZED');
    const [connections, summary, gaps] = await Promise.all([
      this.pool.query(`SELECT connection_id AS id, is_enabled, updated_at FROM telegram_collector.connections
        WHERE bot_id = $1 AND owner_id = $2 ORDER BY connection_id`, [this.botId, this.ownerTelegramId]),
      this.pool.query(`SELECT count(*) AS events_count, coalesce(max(seq), 0) AS snapshot_max_seq FROM telegram_collector.events
        WHERE bot_id = $1 AND owner_id = $2`, [this.botId, this.ownerTelegramId]),
      this.pool.query(`SELECT started_at, ended_at, retention_risk FROM telegram_collector.polling_gaps
        WHERE bot_id = $1 AND ($2::timestamptz IS NULL OR (started_at < $3 AND ended_at > $2))
        ORDER BY ended_at DESC, seq DESC LIMIT 51`, [this.botId, windowFrom, windowTo]),
    ]);
    const row = state.rows[0];
    return { ...row, next_offset: row.next_offset == null ? null : Number(row.next_offset), started_at: iso(row.started_at)!,
      last_update_at: iso(row.last_update_at), last_response_at: iso(row.last_response_at), last_poll_at: iso(row.last_poll_at),
      events_count: String(summary.rows[0].events_count), snapshot_max_seq: String(summary.rows[0].snapshot_max_seq),
      connections: connections.rows.map(value => ({ ...value, updated_at: iso(value.updated_at)! })),
      polling_gaps: gaps.rows.slice(0, 50).map(value => ({ ...value, started_at: iso(value.started_at)!, ended_at: iso(value.ended_at)! })),
      gaps_has_more: gaps.rows.length > 50 };
  }

  async readEvents(input: { from: string; to: string; afterSeq?: string; maxSeq?: string; limit: number }): Promise<{
    events: TelegramJournalEvent[]; has_more: boolean; next_after_seq: string | null; snapshot_max_seq: string;
  }> {
    await this.assertOwner();
    const from = new Date(input.from), to = new Date(input.to);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to || !Number.isInteger(input.limit)
      || input.limit < 1 || input.limit > 200) invalid('TELEGRAM_READ_INPUT_INVALID');
    const after = seqValue(input.afterSeq) ?? '0';
    const maximum = seqValue(input.maxSeq) ?? String((await this.pool.query(`SELECT coalesce(max(seq), 0) AS maximum
      FROM telegram_collector.events WHERE bot_id = $1 AND owner_id = $2`, [this.botId, this.ownerTelegramId])).rows[0].maximum);
    const result = await this.pool.query(`SELECT * FROM telegram_collector.events WHERE bot_id = $1 AND owner_id = $2
      AND seq > $3 AND seq <= $4 AND ((event_at >= $5 AND event_at < $6) OR (received_at >= $5 AND received_at < $6))
      ORDER BY seq LIMIT $7`, [this.botId, this.ownerTelegramId, after, maximum, from, to, input.limit + 1]);
    const rows: TelegramJournalEvent[] = result.rows.slice(0, input.limit).map(row => ({ ...row, seq: String(row.seq), update_id: String(row.update_id),
      message_at: iso(row.message_at), edit_at: iso(row.edit_at), event_at: iso(row.event_at)!, received_at: iso(row.received_at)! }));
    return { events: rows, has_more: result.rows.length > input.limit,
      next_after_seq: rows.length ? String(rows.at(-1)!.seq) : null, snapshot_max_seq: maximum };
  }

  private async assertOwner(): Promise<void> {
    const result = await this.pool.query('SELECT owner_id FROM telegram_collector.state WHERE bot_id = $1', [this.botId]);
    if (!result.rows.length) invalid('TELEGRAM_STORE_NOT_INITIALIZED');
    if (result.rows[0].owner_id !== this.ownerTelegramId) invalid('TGC_OWNER_MISMATCH');
  }
}
