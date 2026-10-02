import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ownsiteMigrationSql } from './schema.ts';
import { seedWorks, contentRevision } from './seed-works.ts';

const text = z.string().min(1).max(12000);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const httpsUrl = z.string().max(2000).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}, 'Public URLs must use HTTPS without credentials');
const poster = z.string().max(500).regex(/^\/assets\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
  .refine(value => !value.split('/').includes('..'));
const link = z.strictObject({ label: text, href: httpsUrl });
const section = z.strictObject({ heading: text, body: text });
const tool = z.strictObject({ label: text, href: httpsUrl, poster: poster.optional() });
const workFields = {
  title: text, displayTitle: text.nullable(), kind: z.enum(['it','authorial','content']),
  category: text, status: text, role: text, summary: text,
  theme: z.enum(['arena','folio','neutral']), orientation: z.enum(['portrait','landscape']),
  liveUrl: httpsUrl.nullable(), embedAllowed: z.boolean(),
  links: z.array(link).max(30), poster: poster.nullable(), reveal: z.array(section).max(30),
  tools: z.array(tool).max(30), featuredOrder: z.number().int().min(0).max(100000).nullable(),
  catalogueOrder: z.number().int().min(0).max(100000), show: z.boolean().nullable()
};
const storedWorkSchema = z.strictObject(workFields);
const patchSchema = storedWorkSchema.partial().extend({ slug: slug.optional() })
  .refine(value => Object.keys(value).length > 0, 'Empty patch');
const listInput = z.strictObject({});
const updateInput = z.strictObject({ id: slug, patch: patchSchema });
type StoredWork = z.infer<typeof storedWorkSchema>;
type Field = keyof StoredWork;
const parameterTypes: Record<Field, 'text'|'boolean'|'integer'|'json'> = {
  title:'text',displayTitle:'text',kind:'text',category:'text',status:'text',role:'text',summary:'text',
  theme:'text',orientation:'text',liveUrl:'text',embedAllowed:'boolean',links:'json',poster:'text',
  reveal:'json',tools:'json',featuredOrder:'integer',catalogueOrder:'integer',show:'boolean'
};
const nullableFields = new Set<Field>(['displayTitle','liveUrl','poster','featuredOrder','show']);
export const ownsiteToolDefinitions = [
  { name:'ownsite_list_works', description:'Read all portfolio cards, visibility and constructor parameters. Owner only.',
    inputSchema:z.toJSONSchema(listInput), annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false} },
  { name:'ownsite_update_work', description:'Update selected fields of one portfolio card transactionally. No deletion. Owner only.',
    inputSchema:z.toJSONSchema(updateInput), annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false} }
];
export class OwnsiteError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'OwnsiteError'; }
}
const workQuery = `SELECT e.id,e.slug,COALESCE(jsonb_object_agg(v.parameter_key,
  CASE WHEN v.is_null THEN 'null'::jsonb
    WHEN v.data_type='text' THEN to_jsonb(v.text_value)
    WHEN v.data_type='boolean' THEN to_jsonb(v.boolean_value)
    WHEN v.data_type='integer' THEN to_jsonb(v.integer_value)
    ELSE v.json_value END) FILTER (WHERE v.parameter_key IS NOT NULL),'{}'::jsonb) AS fields
  FROM ownsite.entities e LEFT JOIN ownsite.entity_parameter_values v
    ON v.entity_id=e.id AND v.entity_type=e.entity_type
  WHERE e.entity_type='portfolio-work'`;
const visible = `AND EXISTS (SELECT 1 FROM ownsite.entity_parameter_values flag
  WHERE flag.entity_id=e.id AND flag.entity_type=e.entity_type AND flag.parameter_key='show'
    AND flag.data_type='boolean' AND flag.is_null=FALSE AND flag.boolean_value=TRUE)`;
type WorkRow = { id:string; slug:string; fields:Record<string, unknown> };
function parseRow(row:WorkRow) {
  // Unknown constructor fields are never copied into the public projection.
  const fields = Object.fromEntries(Object.keys(parameterTypes).map(key => [key,row.fields[key]]));
  // Missing publication flag is closed; owner can restore it using a partial patch.
  if (fields.show === undefined) fields.show = null;
  return { id:row.id, slug:slug.parse(row.slug), ...storedWorkSchema.parse(fields) };
}
function publicDto(row:WorkRow) {
  const w = parseRow(row);
  if (w.show !== true) throw new OwnsiteError('OWNSITE_NOT_PUBLIC');
  return { id:w.id,slug:w.slug,title:w.title,displayTitle:w.displayTitle || w.title,kind:w.kind,
    category:w.category,status:w.status,role:w.role,summary:w.summary,theme:w.theme,orientation:w.orientation,
    liveUrl:w.liveUrl,embedAllowed:w.embedAllowed,links:w.links,poster:w.poster,reveal:w.reveal,
    tools:w.tools,featuredOrder:w.featuredOrder };
}
function sortRows(rows:WorkRow[]) {
  return rows.sort((a,b) => {
    const x = parseRow(a), y = parseRow(b);
    return (x.featuredOrder ?? Infinity) - (y.featuredOrder ?? Infinity)
      || x.catalogueOrder-y.catalogueOrder || x.slug.localeCompare(y.slug);
  });
}
async function writeField(client:Pick<PoolClient,'query'>, id:string, key:Field, value:unknown) {
  return writeTypedField(client,id,'portfolio-work',key,parameterTypes[key],value);
}
async function writeTypedField(client:Pick<PoolClient,'query'>, id:string,entityType:string,key:string,
  kind:'text'|'boolean'|'integer'|'json',value:unknown) {
  const {rows} = await client.query(`SELECT data_type,nullable FROM ownsite.entity_parameters
    WHERE entity_type=$1 AND key=$2`,[entityType,key]);
  if (!rows.length || rows[0].data_type !== kind || (value===null && !rows[0].nullable))
    throw new OwnsiteError('OWNSITE_METADATA_INVALID');
  await client.query(`INSERT INTO ownsite.entity_parameter_values
    (entity_id,entity_type,parameter_key,data_type,is_null,text_value,boolean_value,integer_value,json_value,parameter_nullable)
    VALUES ($1,$10,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
    ON CONFLICT(entity_id,parameter_key) DO UPDATE SET data_type=EXCLUDED.data_type,
      is_null=EXCLUDED.is_null,text_value=EXCLUDED.text_value,boolean_value=EXCLUDED.boolean_value,
      integer_value=EXCLUDED.integer_value,json_value=EXCLUDED.json_value,parameter_nullable=EXCLUDED.parameter_nullable`,
    [id,key,kind,value===null,kind==='text'?value:null,kind==='boolean'?value:null,
      kind==='integer'?value:null,kind==='json' && value!==null?JSON.stringify(value):null,rows[0].nullable,entityType]);
}
export type OwnsiteContacts = { phone?:string; email?:string };
const publicPhoneSchema=z.string().regex(/^\+[0-9]{10,15}$/);
const publicEmailSchema=z.email().max(254).refine(value=>!/[?#\u0000-\u0020\u007f]/.test(value),
  'Public email must not contain URI headers, fragments or controls');
export interface OwnsiteGateway {
  credentialId:string;
  toolDefinitions:typeof ownsiteToolDefinitions;
  handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>;
  callTool(name:string,input:unknown,callerCredentialId:string):Promise<Record<string,unknown>>;
  publicWorks():Promise<ReturnType<typeof publicDto>[]>;
  publicWork(slug:string):Promise<ReturnType<typeof publicDto>|null>;
  publicContacts():Promise<{label:string;href:string}[]>;
}
export async function createOwnsiteGateway(pool:Pool, credentialId:string,
  contacts:OwnsiteContacts = {phone:'+79065253445',email:'info@yarcyberseason.ru'}):Promise<OwnsiteGateway> {
  if (!z.uuid().safeParse(credentialId).success) throw new OwnsiteError('OWNSITE_CREDENTIAL_REQUIRED');
  const contactInput = z.strictObject({phone:publicPhoneSchema.optional(),
    email:publicEmailSchema.optional()}).safeParse(contacts);
  if (!contactInput.success) throw new OwnsiteError('OWNSITE_CONTACTS_INVALID');
  const seededContacts = {phone:contactInput.data.phone ?? '+79065253445',
    email:contactInput.data.email ?? 'info@yarcyberseason.ru'};
  const owner = credentialId.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(892761, 2)');
    // node-pg supports batches; separate statements also support PostgreSQL-compatible test adapters.
    for (const statement of ownsiteMigrationSql.split(';').filter(s=>s.trim())) await client.query(statement);
    await client.query(`INSERT INTO ownsite.entity_types(id,title) VALUES ('portfolio-work','Portfolio work') ON CONFLICT DO NOTHING`);
    for (const [key,kind] of Object.entries(parameterTypes)) await client.query(`INSERT INTO ownsite.entity_parameters
      (entity_type,key,data_type,title,nullable) VALUES ('portfolio-work',$1,$2,$1,$3) ON CONFLICT DO NOTHING`,
      [key,kind,nullableFields.has(key as Field)]);
    for (const seed of seedWorks) {
      const {rows} = await client.query(`INSERT INTO ownsite.entities(id,entity_type,slug)
        VALUES ($1,'portfolio-work',$2) ON CONFLICT(id) DO NOTHING RETURNING id`,[seed.id,seed.slug]);
      // Populate values only for a newly inserted entity. Restart never restores a removed field or resets visibility.
      if (!rows.length) continue;
      const candidate = {
        title:seed.title,displayTitle:seed.display_title ?? null,kind:seed.kind,category:seed.category,
        status:seed.status,role:seed.role,summary:seed.summary,theme:seed.theme,orientation:seed.orientation ?? 'portrait',
        liveUrl:seed.live_url ?? null,embedAllowed:seed.embed_allowed === 1,
        links:JSON.parse(seed.links_json ?? '[]'),poster:seed.poster ?? null,
        reveal:JSON.parse(seed.reveal_json ?? '[]'),tools:[],featuredOrder:seed.featured_order ?? null,
        catalogueOrder:seed.catalogue_order,show:seed.show === 1
      };
      const parsed = storedWorkSchema.parse(candidate);
      for (const [key,value] of Object.entries(parsed)) await writeField(client,seed.id,key as Field,value);
    }
    await client.query(`INSERT INTO ownsite.site_settings(key,value) VALUES ('seed_revision',$1) ON CONFLICT DO NOTHING`,[contentRevision]);
    await client.query(`INSERT INTO ownsite.entity_types(id,title)
      VALUES ('portfolio-contacts','Public portfolio contacts') ON CONFLICT DO NOTHING`);
    for (const key of ['phone','email']) await client.query(`INSERT INTO ownsite.entity_parameters
      (entity_type,key,data_type,title,nullable) VALUES ('portfolio-contacts',$1,'text',$1,TRUE) ON CONFLICT DO NOTHING`,[key]);
    const {rows:contactEntities}=await client.query(`INSERT INTO ownsite.entities(id,entity_type,slug)
      VALUES ('public-contacts','portfolio-contacts','public-contacts') ON CONFLICT(id) DO NOTHING RETURNING id`);
    if (contactEntities.length) for (const [key,value] of Object.entries(seededContacts))
      await writeTypedField(client,'public-contacts','portfolio-contacts',key,'text',value);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { client.release(); }

  async function publicWorks() {
    const {rows} = await pool.query<WorkRow>(`${workQuery} ${visible} GROUP BY e.id,e.slug`);
    return sortRows(rows).map(publicDto);
  }
  async function publicWork(value:string) {
    if (!slug.safeParse(value).success) return null;
    const {rows} = await pool.query<WorkRow>(`${workQuery} ${visible} AND e.slug=$1 GROUP BY e.id,e.slug`,[value]);
    return rows.length?publicDto(rows[0]):null;
  }
  async function publicContacts() {
    const {rows} = await pool.query(`SELECT parameter_key,text_value FROM ownsite.entity_parameter_values
      WHERE entity_id='public-contacts' AND entity_type='portfolio-contacts'
        AND parameter_key IN ('phone','email') AND data_type='text' AND is_null=FALSE`);
    const fields = Object.fromEntries(rows.map(row=>[row.parameter_key,row.text_value]));
    const result = [];
    if (publicPhoneSchema.safeParse(fields.phone).success) result.push({label:'Позвонить',href:`tel:${fields.phone}`});
    if (publicEmailSchema.safeParse(fields.email).success) result.push({label:'Написать письмо',href:`mailto:${fields.email}`});
    return result;
  }
  async function callTool(name:string,input:unknown,callerCredentialId:string):Promise<Record<string,unknown>> {
    if (typeof callerCredentialId !== 'string' || callerCredentialId.toLowerCase() !== owner)
      throw new OwnsiteError('OWNSITE_FORBIDDEN');
    if (name==='ownsite_list_works') {
      if (!listInput.safeParse(input).success) throw new OwnsiteError('OWNSITE_INPUT_INVALID');
      const {rows} = await pool.query<WorkRow>(`${workQuery} GROUP BY e.id,e.slug`);
      const metadata = await pool.query(`SELECT key,data_type,title,nullable FROM ownsite.entity_parameters
        WHERE entity_type='portfolio-work' ORDER BY key`);
      return {works:sortRows(rows).map(parseRow),parameters:metadata.rows};
    }
    if (name!=='ownsite_update_work') throw new OwnsiteError('OWNSITE_UNKNOWN_TOOL');
    const checked = updateInput.safeParse(input);
    if (!checked.success) throw new OwnsiteError('OWNSITE_INPUT_INVALID');
    const {id,patch} = checked.data;
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const {rows:locked} = await tx.query(`SELECT id FROM ownsite.entities
        WHERE id=$1 AND entity_type='portfolio-work' FOR UPDATE`,[id]);
      if (!locked.length) throw new OwnsiteError('OWNSITE_NOT_FOUND');
      const {rows} = await tx.query<WorkRow>(`${workQuery} AND e.id=$1 GROUP BY e.id,e.slug`,[id]);
      const old = parseRow(rows[0]);
      storedWorkSchema.parse(Object.fromEntries(Object.keys(parameterTypes).map(key=>[key,
        Object.hasOwn(patch,key)?patch[key as Field]:old[key as Field]])));
      if (patch.slug!==undefined) await tx.query('UPDATE ownsite.entities SET slug=$2 WHERE id=$1',[id,patch.slug]);
      for (const [key,value] of Object.entries(patch)) if (key!=='slug') await writeField(tx,id,key as Field,value);
      await tx.query('UPDATE ownsite.entities SET updated_at=now() WHERE id=$1',[id]);
      const {rows:updated} = await tx.query<WorkRow>(`${workQuery} AND e.id=$1 GROUP BY e.id,e.slug`,[id]);
      const work = parseRow(updated[0]);
      await tx.query('COMMIT');
      return {work};
    } catch (error) { await tx.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { tx.release(); }
  }
  async function handle(req:IncomingMessage,res:ServerResponse):Promise<boolean> {
    let path:string;
    let search:string;
    try { const url = new URL(req.url ?? '/', 'http://ownsite.invalid'); path=url.pathname; search=url.search; }
    catch { return false; }
    if (path!=='/ownsite' && !path.startsWith('/ownsite/')) return false;
    const send = (status:number,value:unknown) => {
      const body = JSON.stringify(value);
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff','Content-Length':Buffer.byteLength(body)});
      res.end(req.method==='HEAD'?undefined:body);
    };
    if (!['GET','HEAD'].includes(req.method ?? '')) { send(405,{error:'METHOD_NOT_ALLOWED'}); return true; }
    if (search) { send(400,{error:'QUERY_NOT_ALLOWED'}); return true; }
    try {
      if (path==='/ownsite/api/works') send(200,await publicWorks());
      else if (path==='/ownsite/api/contacts') send(200,await publicContacts());
      else if (path==='/ownsite/readyz') { await publicWorks(); send(200,{status:'OK'}); }
      else if (path.startsWith('/ownsite/api/works/')) {
        let value:string;
        try { value=decodeURIComponent(path.slice('/ownsite/api/works/'.length)); }
        catch { send(404,{error:'NOT_FOUND'}); return true; }
        const work = await publicWork(value);
        send(work?200:404,work ?? {error:'NOT_FOUND'});
      } else send(404,{error:'NOT_FOUND'});
    } catch { send(503,{error:'OWNSITE_UNAVAILABLE'}); }
    return true;
  }
  return {credentialId:owner,toolDefinitions:ownsiteToolDefinitions,handle,callTool,publicWorks,publicWork,publicContacts};
}
