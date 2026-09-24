import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateOutreach } from '../src/outreach/database.ts';
import { QueuedPublisher, deliveryMigrationSql } from '../src/outreach/telegram-delivery.ts';
import { startLocalOutreach } from '../src/outreach/server.ts';
import { accessMigrationSql } from '../src/outreach/access.ts';
import { registryMigrationSql } from '../src/outreach/registry.ts';
import { generateLogin } from '../src/outreach/access.ts';

// A small, valid square PNG fixture. Nothing in this test is delivered to Telegram.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=';
function largePng() {
  const bytes = Buffer.from(PNG,'base64');
  const payload = Buffer.from('Comment\0'+'a'.repeat(75000));
  const chunk = Buffer.alloc(12+payload.length);
  chunk.writeUInt32BE(payload.length,0);
  chunk.write('tEXt',4); payload.copy(chunk,8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4,-4)) {
    crc ^= byte;
    for (let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0,chunk.length-4);
  return Buffer.concat([bytes.subarray(0,-12),chunk,bytes.subarray(-12)]).toString('base64');
}

test('migrate existing database and deliver each cover before its text without duplicate sends', {
  skip: !process.env.OUTREACH_TEST_DATABASE_URL ? 'OUTREACH_TEST_DATABASE_URL required' : false,
}, async () => {
  const admin = new pg.Pool({ connectionString: process.env.OUTREACH_TEST_DATABASE_URL });
  const schema = `telegram_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.OUTREACH_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const workerToken = 'fixture_worker_token_that_is_long_enough_123';
  const config = {profile:'publisher' as const,publishEnabled:true,deliveryMode:'worker' as const,workerToken,
    taskChannels:{task_one:'@talyutinstories',task_two:'-100445566'}};
  let app: Awaited<ReturnType<typeof startLocalOutreach>> | undefined;
  try {
    await pool.query(accessMigrationSql);
    await pool.query(registryMigrationSql);
    await pool.query(deliveryMigrationSql);
    await pool.query('CREATE TABLE outreach_schema_version(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),version integer NOT NULL)');
    await pool.query('INSERT INTO outreach_schema_version(singleton,version) VALUES(true,2)');
    await migrateOutreach(pool); await migrateOutreach(pool);
    assert.equal((await pool.query('SELECT version FROM outreach_schema_version')).rows[0].version,3);
    const queue = new QueuedPublisher(pool,config);
    async function claimOne(q: QueuedPublisher) {
      const job = await q.claim();
      if (!('status' in job) || job.status !== 'claimed') throw new Error('Claim expected');
      return job;
    }
    async function story(task_id: string, story_id: string, text: string) {
      const upload = await queue.uploadCover({task_id,story_id,mime_type:'image/png',image_base64:PNG});
      if (!('cover_id' in upload) || !upload.cover_id) throw new Error('Cover staging failed');
      return {task_id,story_id,text,cover_id:upload.cover_id,attempt_id:randomUUID(),expected_instance_id:randomUUID()};
    }
    const first = await story('task_one','same-story','First part\n');
    const second = await story('task_two','same-story','Second channel');
    assert.equal((await queue.publish({...first,task_id:'unknown'})).code,'TASK_NOT_CONFIGURED');
    assert.equal((await queue.publish({...first,cover_id:randomUUID()})).code,'COVER_NOT_FOUND');
    assert.equal((await queue.publish(first)).status,'QUEUED');
    assert.equal((await queue.publish({...first,attempt_id:randomUUID()})).attempt_id,first.attempt_id);
    assert.equal((await queue.publish({...first,text:'Changed text'})).code,'ATTEMPT_CONFLICT');
    assert.equal((await queue.publish(second)).status,'QUEUED');
    const [one,two] = await Promise.all([claimOne(queue),claimOne(queue)]);
    assert.notEqual(one.attempt_id,two.attempt_id);
    const picked = one.task_id === 'task_one' ? one : two;
    const other = one.task_id === 'task_one' ? two : one;
    assert.equal(picked.kind,'photo'); assert.equal('image_base64' in picked && picked.image_base64,PNG);
    assert.equal((await queue.begin({attempt_id:picked.attempt_id,lease_id:picked.lease_id,resolved_channel_id:'-100123456'})).status,'ready');
    const afterPhoto = await queue.complete({attempt_id:picked.attempt_id,lease_id:picked.lease_id,outcome:{kind:'confirmed',message_id:77}});
    assert.equal('status' in afterPhoto && afterPhoto.status,'QUEUED');
    assert.equal((await queue.complete({attempt_id:picked.attempt_id,lease_id:picked.lease_id,outcome:{kind:'confirmed',message_id:78}})).code,'LEASE_INVALID');
    const textJob = await claimOne(queue);
    assert.equal(textJob.kind,'text'); assert.equal('text' in textJob && textJob.text,'First part\n');
    assert.equal(textJob.part_index,2);
    assert.equal((await queue.begin({attempt_id:textJob.attempt_id,lease_id:textJob.lease_id,resolved_channel_id:'-100123456'})).status,'ready');
    const published = await queue.complete({attempt_id:textJob.attempt_id,lease_id:textJob.lease_id,outcome:{kind:'confirmed',message_id:78}});
    assert.equal('status' in published && published.status,'PUBLISHED');
    assert.deepEqual('confirmed_messages' in published && published.confirmed_messages.map(x => x.message_id),[77,78]);
    assert.equal((await queue.begin({attempt_id:other.attempt_id,lease_id:other.lease_id,resolved_channel_id:'-100445566'})).status,'ready');
    const uncertain = await queue.complete({attempt_id:other.attempt_id,lease_id:other.lease_id,outcome:{kind:'unknown'}});
    assert.equal('status' in uncertain && uncertain.status,'UNKNOWN');
    assert.equal('uncertain_part_index' in uncertain && uncertain.uncertain_part_index,1);
    assert.deepEqual(await queue.claim(),{status:'empty'});
    const restarted = new QueuedPublisher(pool,config);
    assert.equal((await restarted.attempt({attempt_id:first.attempt_id,expected_instance_id:randomUUID()})).status,'PUBLISHED');
    assert.equal((await restarted.attempt({attempt_id:second.attempt_id,expected_instance_id:randomUUID()})).manual_check_required,true);
    const changedAlias = await story('task_one','new-story','Do not send to renamed channel');
    await restarted.publish(changedAlias);
    const aliasClaim = await claimOne(restarted);
    assert.equal((await restarted.begin({attempt_id:aliasClaim.attempt_id,lease_id:aliasClaim.lease_id,resolved_channel_id:'-100999999'})).code,'CHANNEL_ID_CHANGED');
    assert.equal((await restarted.attempt({attempt_id:changedAlias.attempt_id,expected_instance_id:randomUUID()})).status,'REJECTED');
    app = await startLocalOutreach({pool,telegram:config});
    const api = (action:string, body:object, bearer=workerToken) => fetch(app!.url+'/internal/telegram/'+action,{
      method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify(body),
    });
    assert.equal((await api('routes',{})).status,200);
    assert.equal((await api('routes',{},'wrong')).status,403);
    const login = generateLogin();
    await app.access.addLogin(login,'Cover integration fixture');
    const rpc = async (name:string,args:object) => {
      const response = await fetch(`${app!.url}/mcp?login=${encodeURIComponent(login)}`,{
        method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
        body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}}),
      });
      assert.equal(response.status,200);
      return (await response.json()).result.structuredContent as Record<string, unknown>;
    };
    await new Promise(resolve => setTimeout(resolve,1100));
    const fullCover = largePng();
    assert.ok(fullCover.length > 65536);
    const staged = await rpc('upload_story_cover', {task_id:'task_two',story_id:'mcp-story',mime_type:'image/png',image_base64:fullCover});
    assert.equal(typeof staged.cover_id,'string');
    await new Promise(resolve => setTimeout(resolve,1100));
    const queued = await rpc('publish_story',{task_id:'task_two',story_id:'mcp-story',cover_id:staged.cover_id,
      attempt_id:randomUUID(),expected_instance_id:randomUUID(),text:'MCP cover then story'});
    assert.equal(queued.status,'QUEUED');
    const fromMcp = await api('claim',{});
    const claimed = await fromMcp.json();
    assert.equal(claimed.kind,'photo'); assert.equal(claimed.image_base64,fullCover);
    const state = await restarted.status();
    assert.equal(state.delivery_mode,'worker'); assert.equal(state.service_version,'0.13.0');
    await app.close(); app=undefined;
  } finally {
    await app?.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
