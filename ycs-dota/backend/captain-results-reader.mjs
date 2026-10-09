import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { fail } from './captain-auth.mjs';

// Same published object as the sole results collector. This reader never writes.
export const CAPTAIN_RESULTS_BUCKET = 'e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04';
export const CAPTAIN_RESULTS_KEY = 'results/dota2-autumn-2026.json';
export const CAPTAIN_RESULTS_MAX_BYTES = 8 * 1024 * 1024;

async function readBody(response) {
  if (response.ContentLength > CAPTAIN_RESULTS_MAX_BYTES) { response.Body?.destroy?.(); fail('storage_unavailable', 503); }
  if (!response.Body?.[Symbol.asyncIterator]) fail('storage_unavailable', 503);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.Body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > CAPTAIN_RESULTS_MAX_BYTES) { response.Body.destroy?.(); fail('storage_unavailable', 503); }
    chunks.push(buffer);
  }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  // null is reserved for a confirmed NoSuchKey, never for object contents.
  if (value === null) fail('storage_unavailable', 503);
  return value;
}

export function createCaptainResultsReader({ env = process.env, s3, createS3 = (config) => new S3Client(config) } = {}) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID, secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const configured = typeof accessKeyId === 'string' && Boolean(accessKeyId.trim()) &&
    typeof secretAccessKey === 'string' && Boolean(secretAccessKey.trim());
  let client = s3;
  return async () => {
    if (!configured) fail('storage_unavailable', 503);
    client ||= createS3({ region: 'ru-1', endpoint: 'https://s3.twcstorage.ru', maxAttempts: 1,
      credentials: { accessKeyId, secretAccessKey } });
    let response;
    try {
      response = await client.send(new GetObjectCommand({ Bucket: CAPTAIN_RESULTS_BUCKET, Key: CAPTAIN_RESULTS_KEY }),
        { abortSignal: AbortSignal.timeout(5000) });
    } catch (error) {
      // Generic 404/NotFound and a missing bucket do not prove object absence.
      if (error?.name === 'NoSuchKey') return null;
      throw error;
    }
    return readBody(response);
  };
}
