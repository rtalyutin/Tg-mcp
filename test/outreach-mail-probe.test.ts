import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {MailService} from '../src/outreach/mail.ts';
import {MailTransferError,type MailTransport} from '../src/outreach/smtp.ts';
import {readTestMailConfig} from '../src/outreach/config.ts';

const config=readTestMailConfig({MAIL_TRANSPORT_ENABLED:'true',MAIL_SMTP_PASSWORD:'private-test-value',MAIL_SMTP_PORT:'465'})!;
function service(error:unknown):MailService {
  const transport:MailTransport={probe:async()=>{throw error;},send:async()=>{throw new Error('must not send');}};
  return new MailService({} as Pool,config,transport);
}

test('owner SMTP probe exposes only safe failure categories and selected port',async()=>{
  assert.deepEqual(await service(Object.assign(new Error('private-test-value'),{code:'ETIMEDOUT'})).probe('owner:test'),
    {ready:false,code:'SMTP_PROBE_FAILED',reason:'ETIMEDOUT',port:465});
  assert.deepEqual(await service(new MailTransferError('SMTP_REJECTED',false,535)).probe('owner:test'),
    {ready:false,code:'SMTP_PROBE_FAILED',reason:'SMTP_REJECTED',port:465,smtp_code:535});
  assert.deepEqual(await service(new Error('private-test-value')).probe('owner:test'),
    {ready:false,code:'SMTP_PROBE_FAILED',reason:'SMTP_PROBE_FAILED',port:465});
  assert.deepEqual(await service(new MailTransferError('private-test-value',false)).probe('owner:test'),
    {ready:false,code:'SMTP_PROBE_FAILED',reason:'SMTP_PROBE_FAILED',port:465});
  await assert.rejects(service(new Error('private-test-value')).probe('mcp:visitor'),/Owner required/);
});
