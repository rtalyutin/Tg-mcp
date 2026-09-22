import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Registry, RegistryError, registryMigrationSql, normalizeCompanyName, intakeFingerprint, registryToolDefinitions, executeRegistryTool } from '../src/outreach/registry.ts';
import { sourceSchema, upsertCompanyCandidateSchema } from '../src/outreach/registry-schema.ts';

const source = {url:'https://example.test/research?id=1#section',retrieved_at:'2026-09-20T12:00:00Z',claim:'Organization name appears on this page',verification:'Public web page'};
const candidate = (name: string, extra: Record<string,unknown> = {}) => ({name,sources:[source],rationale:'Relevant to a local esports audience',request_id:randomUUID(),...extra});
const errorCode = (code: string) => (error: unknown) => error instanceof RegistryError && error.code === code;

test('intake identity folds Unicode names and ignores collection time but preserves source identity', () => {
  assert.equal(normalizeCompanyName('  СТРАССЕ   Straße Σς  '),'страссе strasse σσ');
  assert.equal(normalizeCompanyName('Ꭰꭰ'),'ᎠᎠ');
  assert.equal(intakeFingerprint('  BRAND  ',[source]),intakeFingerprint('brand',[{...source,retrieved_at:'2026-09-21T12:00:00Z',claim:'New observation'}]));
  assert.notEqual(intakeFingerprint('brand',[source]),intakeFingerprint('brand',[{...source,url:'https://example.test/research?id=2#section'}]));
  assert.notEqual(intakeFingerprint('brand',[source]),intakeFingerprint('brand',[{...source,url:'https://example.test/research?id=1#other'}]));
  const second = {...source,url:'HTTPS://EXAMPLE.TEST:443/contact'};
  assert.equal(intakeFingerprint('brand',[source,second]),intakeFingerprint('brand',[{...second,url:'https://example.test/contact'},source,source]));
});

test('strict tool inputs reject arbitrary fields, untrusted approval claims, credentials and malformed URLs', () => {
  assert.equal(upsertCompanyCandidateSchema.safeParse(candidate('Test',{inn_verified:true})).success,false);
  assert.equal(upsertCompanyCandidateSchema.safeParse(candidate('Test',{company_id:randomUUID()})).success,false);
  assert.equal(sourceSchema.safeParse({...source,url:'https://user:secret@example.test/'}).success,false);
  assert.equal(sourceSchema.safeParse({...source,url:'not a URL'}).success,false);
  assert.equal(sourceSchema.safeParse({...source,material_id:'file-1'}).success,false);
  assert.ok(registryToolDefinitions.every(tool => tool.inputSchema.additionalProperties === false));
  assert.ok(!registryToolDefinitions.some(tool => /approve|resolve|send|status/.test(tool.name)));
});

test('PostgreSQL registry transactions and separate opportunity statuses', {skip: !process.env.OUTREACH_TEST_DATABASE_URL}, async t => {
  const connectionString = process.env.OUTREACH_TEST_DATABASE_URL!;
  const schema = `registry_test_${randomUUID().replaceAll('-','')}`;
  const admin = new Pool({connectionString});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({connectionString,options:`-c search_path=${schema}`,max:12});
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(registryMigrationSql);
  await pool.query(registryMigrationSql);
  const registry = new Registry(pool);
  const actor = 'mcp:test';
  const owner = 'owner:test';
  let companyId = '';

  await t.test('AC-02 concurrent minimal imports create exactly one unresolved candidate', async () => {
    const imports = Array.from({length:8},() => candidate('  Test   brand  '));
    const results = await Promise.all(imports.map(input => registry.upsertCompanyCandidate(input,actor)));
    assert.equal(new Set(results.map(result => result.candidate_id)).size,1);
    assert.ok(results.every(result => result.company_id === null && result.result === 'needs_review'));
    assert.equal(results.filter(result => result.created).length,1);
    const repeat = await registry.upsertCompanyCandidate(imports[0],actor);
    assert.deepEqual(repeat,results[0]);
    const operation = await registry.getOperation({request_id:imports[0].request_id});
    assert.equal(operation.status,'succeeded');
    assert.deepEqual(operation.result,results[0]);
    await assert.rejects(registry.upsertCompanyCandidate({...imports[0],rationale:'Changed payload'},actor),errorCode('IDEMPOTENCY_CONFLICT'));
    const stats = await pool.query('SELECT (SELECT count(*) FROM outreach_candidates)::int AS candidates,(SELECT count(*) FROM outreach_audit)::int AS audits');
    assert.deepEqual(stats.rows[0],{candidates:1,audits:1});
  });

  await t.test('parallel retries with one request_id return the same committed result', async () => {
    const input = candidate('Idempotency concurrency');
    const results = await Promise.all(Array.from({length:6},() => registry.upsertCompanyCandidate(input,actor)));
    for (const result of results) assert.deepEqual(result,results[0]);
    const count = await pool.query('SELECT count(*)::int AS count FROM outreach_operations WHERE request_id=$1',[input.request_id]);
    assert.equal(count.rows[0].count,1);
  });

  await t.test('only owner can resolve; assistant-supplied INN remains an unconfirmed claim', async () => {
    const input = candidate('Confirmed Company',{inn:'7707083893',website:'https://shared.example.test/'});
    const intake = await registry.upsertCompanyCandidate(input,actor);
    assert.equal(intake.result,'needs_review');
    const resolution = {candidate_id:intake.candidate_id,expected_version:1,request_id:randomUUID()};
    await assert.rejects(registry.resolveCandidate(resolution,actor),errorCode('FORBIDDEN'));
    const resolved = await registry.resolveCandidate(resolution,owner);
    companyId = resolved.company_id;
    assert.equal(resolved.company.inn,'7707083893');
    assert.equal(resolved.company.kind,'company');
    assert.deepEqual(await registry.resolveCandidate(resolution,owner),resolved);
    await assert.rejects(executeRegistryTool(registry,'resolve_candidate',resolution,actor),errorCode('UNKNOWN_TOOL'));
    const repeatedImport = await registry.upsertCompanyCandidate({...input,request_id:randomUUID()},actor);
    assert.equal(repeatedImport.company_id,companyId);
  });

  await t.test('AC-03 two brands sharing a domain remain separate and expose possible matches', async () => {
    const intake = await registry.upsertCompanyCandidate(candidate('Second Brand',{website:'https://shared.example.test/'}),actor);
    const card = await registry.getCompany({id:intake.candidate_id});
    assert.ok(card.possible_matches.some((match: {id:string}) => match.id === companyId));
    const resolved = await registry.resolveCandidate({candidate_id:intake.candidate_id,expected_version:1,request_id:randomUUID()},owner);
    assert.notEqual(resolved.company_id,companyId);
    const search = await registry.searchCompanies({q:'Brand'});
    assert.equal(search.items.length,2);
  });

  await t.test('confirmed INN resolves atomically to one company across different candidates', async () => {
    const imports = await Promise.all(['Legal Name A','Legal Name B'].map(name => registry.upsertCompanyCandidate(candidate(name,{inn:'7707083893'}),actor)));
    const resolved = await Promise.all(imports.map(intake => registry.resolveCandidate({candidate_id:intake.candidate_id,expected_version:1,request_id:randomUUID()},owner)));
    assert.ok(resolved.every(result => result.company_id === companyId));
    const count = await pool.query('SELECT count(*)::int AS count FROM outreach_companies WHERE inn=$1',['7707083893']);
    assert.equal(count.rows[0].count,1);
  });

  await t.test('concurrent company edits guard the current version and preserve source history', async () => {
    const before = await registry.getCompany({id:companyId});
    const inputs = ['A','B'].map(letter => candidate('Confirmed Company',{company_id:companyId,expected_version:before.version,
      sources:[{...source,url:`https://example.test/${letter}`}],rationale:`New rationale ${letter}`}));
    const results = await Promise.allSettled(inputs.map(input => registry.upsertCompanyCandidate(input,actor)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(errorCode('VERSION_CONFLICT')(failure.reason));
    const after = await registry.getCompany({id:companyId});
    assert.equal(after.version,before.version+1);
    assert.equal(after.sources.length,before.sources.length+1);
    const failedInput = inputs[results.findIndex(result => result.status === 'rejected')];
    const op = await registry.getOperation({request_id:failedInput.request_id});
    assert.equal(op.status,'failed');
    assert.equal(op.error.code,'VERSION_CONFLICT');
    await assert.rejects(registry.upsertCompanyCandidate(failedInput,actor),errorCode('VERSION_CONFLICT'));
    await assert.rejects(registry.upsertCompanyCandidate(candidate('Company',{company_id:companyId,expected_version:after.version,inn:null}),actor),errorCode('IDENTITY_REVIEW_REQUIRED'));
  });

  await t.test('contact uniqueness is atomic and email +tags/dots remain separate', async () => {
    const input = {company_id:companyId,email:'a.b+tag@example.test',source,verified_at:'2026-09-20T12:00:00Z',request_id:randomUUID()};
    const results = await Promise.all([registry.saveContact(input,actor),registry.saveContact({...input,request_id:randomUUID()},actor)]);
    assert.equal(results[0].contact.id,results[1].contact.id);
    const noTag = await registry.saveContact({...input,email:'ab@example.test',request_id:randomUUID()},actor);
    assert.notEqual(noTag.contact.id,results[0].contact.id);
    await assert.rejects(registry.saveContact({...input,contact_id:results[0].contact.id,expected_version:99,request_id:randomUUID()},actor),errorCode('VERSION_CONFLICT'));
  });

  await t.test('multiple opportunities retain independent statuses and dates; no manual send claims', async () => {
    const opportunities = await Promise.all(['Logo placement','Team activity'].map(subject => registry.createOpportunity({company_id:companyId,subject,sources:[source],rationale:'Relevant offer',request_id:randomUUID()},actor)));
    const [first,second] = opportunities.map(result => result.opportunity);
    const update = {opportunity_id:first.id,expected_version:1,request_id:randomUUID(),status:'deferred',deferred_reason:'Discuss after event',next_step:'Revisit',next_step_at:'2026-10-01T08:00:00Z'};
    await assert.rejects(registry.setOpportunityStatus(update,actor),errorCode('FORBIDDEN'));
    await registry.setOpportunityStatus(update,owner);
    const card = await registry.getCompany({id:companyId});
    assert.equal(card.opportunities.find((value: {id:string}) => value.id === first.id).status,'deferred');
    assert.equal(card.opportunities.find((value: {id:string}) => value.id === second.id).status,'candidate');
    assert.equal(card.status,'confirmed');
    const filtered = await registry.searchCompanies({status:'deferred'});
    assert.equal(filtered.items.length,1);
    assert.equal(filtered.items[0].opportunities.length,2);
    await assert.rejects(registry.setOpportunityStatus({...update,request_id:randomUUID(),next_step_at:null},owner),errorCode('VALIDATION_ERROR'));
    await assert.rejects(registry.setOpportunityStatus({opportunity_id:second.id,expected_version:1,request_id:randomUUID(),status:'awaiting_reply'},owner),errorCode('EVENT_REQUIRED'));
    await assert.rejects(registry.setOpportunityStatus({opportunity_id:first.id,expected_version:2,request_id:randomUUID(),status:'preparing'},owner),errorCode('REASON_REQUIRED'));
  });

  await t.test('failed identity resolution is recorded without partial effects', async () => {
    const intake = await registry.upsertCompanyCandidate(candidate('Bad INN',{inn:'1234567890'}),actor);
    const input = {candidate_id:intake.candidate_id,expected_version:1,request_id:randomUUID()};
    await assert.rejects(registry.resolveCandidate(input,owner),errorCode('INVALID_INN'));
    assert.equal((await registry.getCompany({id:intake.candidate_id})).status,'needs_review');
    assert.equal((await registry.getOperation({request_id:input.request_id})).status,'failed');
    const count = await pool.query('SELECT count(*)::int AS count FROM outreach_companies WHERE inn=$1',['1234567890']);
    assert.equal(count.rows[0].count,0);
  });

  await t.test('pagination is stable, read filters do not become SQL, and data survives new Registry instance', async () => {
    const all = await registry.searchCompanies({limit:100});
    let cursor: string|undefined; const ids: string[] = [];
    do {
      const page = await registry.searchCompanies({limit:2,...(cursor ? {cursor} : {})});
      ids.push(...page.items.map(item => item.id)); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.deepEqual(ids,all.items.map(item => item.id));
    assert.equal((await registry.searchCompanies({q:"' OR true --"})).items.length,0);
    assert.equal((await new Registry(pool).getCompany({id:companyId})).id,companyId);
  });
});
