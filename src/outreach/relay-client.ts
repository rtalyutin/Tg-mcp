import { z } from 'zod';
import type { RelayMailConfig } from './config.ts';
import { MailTransferError, type MailTransport, type OutboundMail } from './smtp.ts';

const reply = z.discriminatedUnion('status', [
  z.strictObject({status:z.literal('sent'),smtp_code:z.literal(250)}),
  z.strictObject({status:z.literal('failed'),code:z.string().max(80),smtp_code:z.number().int().min(200).max(599).optional()}),
  z.strictObject({status:z.literal('unknown')}),
]);
const probeReply = z.discriminatedUnion('ready', [
  z.strictObject({ready:z.literal(true)}),
  z.strictObject({ready:z.literal(false),code:z.string().max(80)}),
]);

/** A send has one HTTP attempt. Lost responses are always treated as uncertain. */
export class RelayMailTransport implements MailTransport {
  private readonly config:RelayMailConfig;
  private readonly http:typeof fetch;
  constructor(config:RelayMailConfig, http:typeof fetch=fetch) { this.config=config;this.http=http; }
  private async request(path:string,mail?:OutboundMail):Promise<unknown> {
    const response=await this.http(`${this.config.origin}${path}`,{
      method:mail?'POST':'GET',redirect:'error',
      headers:{Authorization:`Bearer ${this.config.token}`,...(mail?{'Content-Type':'application/json'}:{})},
      ...(mail?{body:JSON.stringify(mail)}:{}),signal:AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error('RELAY_REJECTED');
    return response.json();
  }
  async probe():Promise<void> {
    try {
      const result=probeReply.parse(await this.request('/v1/probe'));
      if (!result.ready) throw new MailTransferError(result.code,false);
    } catch (error) {
      if (error instanceof MailTransferError) throw error;
      throw new MailTransferError('RELAY_UNAVAILABLE',false);
    }
  }
  async send(mail:OutboundMail):Promise<number> {
    if (mail.from !== this.config.username || mail.replyTo !== this.config.username ||
        mail.to !== this.config.recipient) throw new MailTransferError('MAIL_DESTINATION_DENIED',false);
    try {
      const result=reply.parse(await this.request('/v1/send',mail));
      if (result.status === 'sent') return result.smtp_code;
      if (result.status === 'unknown') throw new MailTransferError('RELAY_RESULT_UNKNOWN',true);
      throw new MailTransferError(result.code,false,result.smtp_code);
    } catch (error) {
      if (error instanceof MailTransferError) throw error;
      throw new MailTransferError('RELAY_RESULT_UNKNOWN',true);
    }
  }
}
