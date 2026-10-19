import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { pathToFileURL } from 'node:url';

export const INTAKE_CORS_ORIGIN = 'https://xn--90aiaibl0ahlel5n.xn--p1ai';
export const INTAKE_CORS_HEADERS = Object.freeze(['Content-Type', 'If-None-Match', 'x-amz-acl', 'x-amz-meta-owner', 'x-amz-meta-fingerprint']);
const DEFAULT_BUCKET = 'e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04';
const canonical = (v) => JSON.stringify(v, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
const setEqual = (a, b) => Array.isArray(a) && a.length === b.length && [...a].map(String).map(s => s.toLowerCase()).sort().join('\0') === [...b].map(s => s.toLowerCase()).sort().join('\0');

function exactOrigin(value) {
  try {
    const u = new URL(value);
    if (u.origin !== value || u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error();
    return value;
  } catch { throw Error('CORS_ORIGIN_INVALID'); }
}
export function mergeIntakeCors(rules, origin = INTAKE_CORS_ORIGIN) {
  exactOrigin(origin);
  if (!Array.isArray(rules) || rules.some(rule => !rule || typeof rule !== 'object' || !Array.isArray(rule.AllowedOrigins) || !Array.isArray(rule.AllowedMethods))) throw Error('CORS_READ_INVALID');
  const wanted = { ID: 'ycs-player-intake-direct-v1', AllowedOrigins: [origin], AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: [...INTAKE_CORS_HEADERS] };
  if (rules.some(rule => canonical(rule.AllowedOrigins) === canonical([origin]) && setEqual(rule.AllowedMethods, wanted.AllowedMethods) && setEqual(rule.AllowedHeaders, wanted.AllowedHeaders))) return { changed: false, rules: structuredClone(rules) };
  if (rules.length >= 100) throw Error('CORS_CAPACITY_REACHED');
  const ids = new Set(rules.map(rule => rule.ID));
  for (let suffix = 1; ids.has(wanted.ID); suffix++) wanted.ID = `ycs-player-intake-direct-v1-${suffix}`;
  return { changed: true, rules: [...structuredClone(rules), wanted] };
}

/** Explicit operation only: no bucket ACL/policy/lifecycle request is issued. */
export async function configureIntakeCors({ s3, bucket = DEFAULT_BUCKET, origin = INTAKE_CORS_ORIGIN, apply = false }) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw Error('CORS_BUCKET_INVALID');
  exactOrigin(origin);
  const read = async () => {
    try {
      const answer = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10_000) });
      if (!Array.isArray(answer.CORSRules)) throw Error('CORS_READ_INVALID');
      return answer.CORSRules;
    } catch (error) {
      if (error.name === 'NoSuchCORSConfiguration' && (error.$metadata?.httpStatusCode === undefined || error.$metadata.httpStatusCode === 404)) return [];
      throw Error('CORS_READ_FAILED');
    }
  };
  const prior = await read(); const plan = mergeIntakeCors(prior, origin);
  if (!apply || !plan.changed) return { status: plan.changed ? 'prepared' : 'unchanged', previousRules: prior.length, plannedRules: plan.rules.length };
  // PutBucketCors has no CAS operation. Re-read immediately before its one write
  // and refuse an observed concurrent change; operator must prevent other edits.
  if (canonical(await read()) !== canonical(prior)) throw Error('CORS_CHANGED_CONCURRENTLY');
  let writeUnknown = false;
  try { await s3.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: plan.rules } }), { abortSignal: AbortSignal.timeout(10_000) }); }
  catch { writeUnknown = true; }
  let actual;
  try { actual = await read(); } catch { throw Error('CORS_WRITE_UNKNOWN'); }
  if (canonical(actual) !== canonical(plan.rules)) throw Error(writeUnknown ? 'CORS_WRITE_UNKNOWN' : 'CORS_READBACK_MISMATCH');
  return { status: 'verified', previousRules: prior.length, plannedRules: plan.rules.length };
}

async function main() {
  if (process.argv.length !== 3 || !['--plan', '--apply'].includes(process.argv[2])) {
    console.log('Use --plan to read a proposed merge, or --apply to explicitly write and verify it. No action performed.'); return;
  }
  const env = process.env;
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw Error('CORS_CREDENTIALS_MISSING');
  const s3 = new S3Client({ region: 'ru-1', endpoint: 'https://s3.twcstorage.ru', maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED', credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } });
  const result = await configureIntakeCors({ s3, bucket: env.YCS_PLAYER_BUCKET || env.YCS_CAPTAIN_BUCKET || DEFAULT_BUCKET,
    origin: env.YCS_PLAYER_ORIGIN || INTAKE_CORS_ORIGIN, apply: process.argv[2] === '--apply' });
  console.log(`PLAYER_INTAKE_CORS status=${result.status} previous_rules=${result.previousRules} planned_rules=${result.plannedRules}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const allowed = ['CORS_ORIGIN_INVALID', 'CORS_BUCKET_INVALID', 'CORS_CREDENTIALS_MISSING', 'CORS_CAPACITY_REACHED', 'CORS_READ_INVALID', 'CORS_READ_FAILED', 'CORS_CHANGED_CONCURRENTLY', 'CORS_WRITE_UNKNOWN', 'CORS_READBACK_MISMATCH'];
    console.error(`PLAYER_INTAKE_CORS_FAILED code=${allowed.includes(error.message) ? error.message : 'CORS_FAILED'}`); process.exitCode = 1;
  });
}
