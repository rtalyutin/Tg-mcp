import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateOutreach } from '../src/outreach/database.ts';
import { QueuedPublisher } from '../src/outreach/telegram-delivery.ts';
import { startLocalOutreach } from '../src/outreach/server.ts';
import { accessMigrationSql } from '../src/outreach/access.ts';
import { registryMigrationSql } from '../src/outreach/registry.ts';

test('persistent routed queue, durable send boundary and isolated worker API', {
  skip: !process.env.OUTREACH_TEST_DATABASE_URL ? 'OUTREACH_TEST_DATABASE_URL required' : false,
}, async () => {
  const admin = new pg.Pool({ connectionString: process.env.OUTREACH_TEST_DATABASE_URL });
  const schema = `telegram_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.OUTREACH_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const workerToken = 'fixture_worker_token_that_is_long_enough_123';
  const routes = {task_one:'@talyutinstories',task_two:'-100445566'};
  const config = {profile:'publisher' as const,publishEnabled:true,deliveryMode:'worker' as const,workerToken,taskChannels:routes};
  let app: Awaited<ReturnType<typeof startLocalOutreach>> | undefined;
  try {
    await pool.query(accessMigrationSql);
    await pool.query(registryMigrationSql);
    await pool.query('CREATE TABLE outreach_schema_version(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),version integer NOT NULL)');
    await pool.query('INSERT INTO outreach_schema_version(singleton,version) VALUES(true,1)');
    await migrateOutreach(pool); await migrateOutreach(pool);
    assert.equal((await pool.query('SELECT version FROM outreach_schema_version')).rows[0].version,2);
    const queue = new QueuedPublisher(pool,config);
    const input = {task_id:'task_one',story_id:'same-story',attempt_id:randomUUID(),expected_instance_id:randomUUID(),text:'First part\n'};
    const second = {task_id:'task_two',story_id:'same-story',attempt_id:randomUUID(),expected_instance_id:randomUUID(),text:'Second channel'};
    assert.equal((await queue.publish({...input,task_id:'unknown'})).code,'TASK_NOT_CONFIGURED');
    assert.equal((await queue.publish(input)).status,'QUEUED');
    assert.equal((await queue.publish({...input,attempt_id:randomUUID()})).attempt_id,input.attempt_id);
    assert.equal((await queue.publish({...input,text:'Changed text'})).code,'ATTEMPT_CONFLICT');
    assert.equal((await queue.publish(second)).status,'QUEUED');
    const [one,two] = await Promise.all([queue.claim(),queue.claim()]);
    if (!('attempt_id' in one) || !one.attempt_id || !one.lease_id ||
        !('attempt_id' in two) || !two.attempt_id || !two.lease_id) throw new Error('Expected two claims');
    assert.notEqual(one.attempt_id,two.attempt_id);
    const picked = one.task_id === 'task_one' ? one : two;
    const other = one.task_id === 'task_one' ? two : one;
    assert.equal((await queue.begin({attempt_id:picked.attempt_id!,lease_id:picked.lease_id!,resolved_channel_id:'-100123456'})).status,'ready');
    const published = await queue.complete({attempt_id:picked.attempt_id!,lease_id:picked.lease_id!,outcome:{kind:'confirmed',message_id:77}});
    assert.equal('status' in published && published.status,'PUBLISHED');
    assert.equal((await queue.complete({attempt_id:picked.attempt_id!,lease_id:picked.lease_id!,outcome:{kind:'confirmed',message_id:78}})).code,'LEASE_INVALID');
    assert.equal((await queue.begin({attempt_id:other.attempt_id!,lease_id:other.lease_id!,resolved_channel_id:'-100445566'})).status,'ready');
    const uncertain = await queue.complete({attempt_id:other.attempt_id!,lease_id:other.lease_id!,outcome:{kind:'unknown'}});
    assert.equal('status' in uncertain && uncertain.status,'UNKNOWN');
    const empty = await queue.claim();
    assert.equal('status' in empty && empty.status,'empty');
    const restarted = new QueuedPublisher(pool,config);
    const persisted = await restarted.attempt({attempt_id:input.attempt_id,expected_instance_id:randomUUID()});
    assert.equal(persisted.status,'PUBLISHED');
    assert.deepEqual(persisted.confirmed_messages,[{part_index:1,message_id:77,message_url:null}]);
    assert.equal((await restarted.attempt({attempt_id:second.attempt_id,expected_instance_id:randomUUID()})).manual_check_required,true);
    const changedAlias = { ...input,story_id:'new-story',attempt_id:randomUUID(),text:'Do not send to renamed channel' };
    assert.equal((await restarted.publish(changedAlias)).status,'QUEUED');
    const pendingAlias = await restarted.claim();
    if (!('attempt_id' in pendingAlias) || !pendingAlias.attempt_id || !pendingAlias.lease_id) throw new Error('Expected claim');
    assert.equal((await restarted.begin({attempt_id:pendingAlias.attempt_id,lease_id:pendingAlias.lease_id,resolved_channel_id:'-100999999'})).code,'CHANNEL_ID_CHANGED');
    assert.equal((await restarted.attempt({attempt_id:changedAlias.attempt_id,expected_instance_id:randomUUID()})).status,'REJECTED');
    const long = { ...input,story_id:'long-story',attempt_id:randomUUID(),text:'a'.repeat(4097) };
    assert.equal((await restarted.publish(long)).remaining_parts,2);
    const first = await restarted.claim();
    if (!('attempt_id' in first) || !first.attempt_id || !first.lease_id) throw new Error('Expected claim');
    assert.equal((await restarted.begin({attempt_id:first.attempt_id,lease_id:first.lease_id,resolved_channel_id:'-100123456'})).status,'ready');
    const firstOutcome = await restarted.complete({attempt_id:first.attempt_id,lease_id:first.lease_id,outcome:{kind:'confirmed',message_id:88}});
    assert.equal('status' in firstOutcome && firstOutcome.status,'QUEUED');
    const last = await restarted.claim();
    if (!('attempt_id' in last) || !last.attempt_id || !last.lease_id) throw new Error('Expected second part');
    assert.equal((await restarted.begin({attempt_id:last.attempt_id,lease_id:last.lease_id,resolved_channel_id:'-100123456'})).status,'ready');
    await pool.query("UPDATE telegram_deliveries SET lease_until=now()-interval '1 second' WHERE attempt_id=$1",[long.attempt_id]);
    const uncertainPart = await restarted.attempt({attempt_id:long.attempt_id,expected_instance_id:randomUUID()});
    assert.equal(uncertainPart.status,'UNKNOWN');
    assert.equal(uncertainPart.confirmed_messages.length,1);
    assert.equal(uncertainPart.uncertain_part_index,2);
    const none = await restarted.claim();
    assert.equal('status' in none && none.status,'empty');
    app = await startLocalOutreach({pool,telegram:config});
    const api = (action:string, body:object, bearer=workerToken) => fetch(app!.url+'/internal/telegram/'+action,{
      method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify(body),
    });
    assert.equal((await api('routes',{})).status,200);
    assert.equal((await api('routes',{},'wrong')).status,403);
    const state = await restarted.status();
    assert.equal(state.delivery_mode,'worker');
    assert.equal(state.telegram_ready,false);
    await app.close(); app=undefined;
  } finally {
    await app?.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
