import net from 'node:net';
import tls from 'node:tls';
import type { TestMailConfig } from './config.ts';

export interface OutboundMail { to: string; from: string; replyTo: string; subject: string; body: string; messageId: string }
export interface MailTransport { probe(): Promise<void>; send(mail: OutboundMail): Promise<number> }
export class MailTransferError extends Error {
  readonly code:string; readonly uncertain:boolean; readonly smtpCode?:number;
  constructor(code: string, uncertain: boolean, smtpCode?: number) {
    super(code);this.code=code;this.uncertain=uncertain;this.smtpCode=smtpCode;
  }
}

class Replies {
  private readonly socket:net.Socket|tls.TLSSocket;
  private pending: string[] = [];
  private fragment = '';
  private waiter: { resolve:(line:string)=>void; reject:(err:Error)=>void } | undefined;
  private failure: Error | undefined;
  readonly onData = (chunk: Buffer) => {
    this.fragment += chunk.toString('utf8');
    if (this.fragment.length > 65536) { this.fail(new Error('SMTP_RESPONSE_TOO_LONG')); return; }
    let end: number;
    while ((end = this.fragment.indexOf('\n')) >= 0) {
      const line = this.fragment.slice(0,end).replace(/\r$/, '');
      this.fragment = this.fragment.slice(end+1);
      if (line.length > 4096) { this.fail(new Error('SMTP_RESPONSE_TOO_LONG')); return; }
      const waiter = this.waiter;
      if (waiter) { this.waiter = undefined; waiter.resolve(line); }
      else this.pending.push(line);
    }
  };
  readonly onError = () => this.fail(new Error('SMTP_CONNECTION_LOST'));
  private fail(error: Error) { this.failure = error; this.waiter?.reject(error); this.waiter = undefined; }
  constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket=socket;
    socket.on('data',this.onData); socket.on('error',this.onError); socket.on('close',this.onError);
    socket.setTimeout(15_000, () => socket.destroy());
  }
  async line(): Promise<string> {
    if (this.pending.length) return this.pending.shift()!;
    if (this.failure) throw this.failure;
    return new Promise((resolve,reject) => { this.waiter = {resolve,reject}; });
  }
  async response(): Promise<{ code:number; lines:string[] }> {
    const lines: string[] = []; let code = 0;
    for (let i=0; i<40; i++) {
      const line = await this.line();
      if (!/^[2-5]\d\d[ -]/.test(line)) throw new Error('SMTP_BAD_RESPONSE');
      if (code && code !== Number(line.slice(0,3))) throw new Error('SMTP_BAD_RESPONSE');
      code = Number(line.slice(0,3)); lines.push(line);
      if (line[3] === ' ') return {code,lines};
    }
    throw new Error('SMTP_TOO_MANY_LINES');
  }
  async command(line: string, expected: number[]): Promise<{code:number; lines:string[]}> {
    if (this.socket.destroyed) throw new Error('SMTP_CONNECTION_LOST');
    this.socket.write(`${line}\r\n`);
    const reply = await this.response();
    if (!expected.includes(reply.code)) throw new MailTransferError('SMTP_REJECTED',false,reply.code);
    return reply;
  }
  detach() { this.socket.off('data',this.onData); this.socket.off('error',this.onError); this.socket.off('close',this.onError); }
}

function header(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new MailTransferError('INVALID_HEADER',false);
  const segments:string[]=[];let chunk='';
  for (const character of value) {
    if (Buffer.byteLength(chunk+character,'utf8')>45) { segments.push(chunk);chunk=''; }
    chunk+=character;
  }
  if (chunk) segments.push(chunk);
  return segments.map(part=>`=?UTF-8?B?${Buffer.from(part,'utf8').toString('base64')}?=`).join('\r\n ');
}
export function renderMimeMessage(mail: OutboundMail): string {
  if ([mail.from,mail.to,mail.replyTo,mail.messageId].some(value => /[\r\n\0]/.test(value))) throw new MailTransferError('INVALID_HEADER',false);
  const content = Buffer.from(mail.body,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  return [`From: <${mail.from}>`,`To: <${mail.to}>`,`Reply-To: <${mail.replyTo}>`,
    `Subject: ${header(mail.subject)}`,`Date: ${new Date().toUTCString()}`,`Message-ID: <${mail.messageId}>`,
    'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64','',content,''].join('\r\n');
}

/** TLS certificate validation and the fixed Timeweb host are mandatory in production. */
export class TimewebSmtp implements MailTransport {
  private readonly config:TestMailConfig;
  constructor(config: TestMailConfig) { this.config=config; }
  private async connect(): Promise<{ socket:tls.TLSSocket; replies:Replies }> {
    const {host,port,username,password} = this.config;
    let socket: net.Socket | tls.TLSSocket;
    if (port === 465) {
      socket = tls.connect({host,port,servername:host,rejectUnauthorized:true,minVersion:'TLSv1.2'});
      await new Promise<void>((resolve,reject) => {
        socket.once('secureConnect',resolve); socket.once('error',reject);
        socket.setTimeout(15_000, () => socket.destroy());
      });
    } else {
      socket = net.connect({host,port});
      await new Promise<void>((resolve,reject) => {
        socket.once('connect',resolve); socket.once('error',reject);
        socket.setTimeout(15_000, () => socket.destroy());
      });
    }
    let replies = new Replies(socket);
    try {
      if (port === 587) {
        const greeting = await replies.response();
        if (greeting.code !== 220) throw new MailTransferError('SMTP_GREETING_REJECTED',false,greeting.code);
        const hello = await replies.command('EHLO ycs.bar',[250]);
        if (!hello.lines.some(line => /^250[ -]STARTTLS(?:\s|$)/i.test(line))) throw new MailTransferError('SMTP_TLS_UNAVAILABLE',false);
        await replies.command('STARTTLS',[220]); replies.detach();
        socket = tls.connect({socket,servername:host,rejectUnauthorized:true,minVersion:'TLSv1.2'});
        await new Promise<void>((resolve,reject) => {
          socket.once('secureConnect',resolve); socket.once('error',reject);
          socket.setTimeout(15_000, () => socket.destroy());
        });
        replies = new Replies(socket);
      } else {
        const greeting = await replies.response();
        if (greeting.code !== 220) throw new MailTransferError('SMTP_GREETING_REJECTED',false,greeting.code);
      }
      const hello = await replies.command('EHLO ycs.bar',[250]);
      const mechanisms=hello.lines.filter(line=>/^250[ -]AUTH\s+/i.test(line)).join(' ').toUpperCase();
      if (/\bPLAIN\b/.test(mechanisms)) {
        await replies.command(`AUTH PLAIN ${Buffer.from(`\0${username}\0${password}`).toString('base64')}`,[235]);
      } else if (/\bLOGIN\b/.test(mechanisms)) {
        await replies.command('AUTH LOGIN',[334]);
        await replies.command(Buffer.from(username).toString('base64'),[334]);
        await replies.command(Buffer.from(password).toString('base64'),[235]);
      } else throw new MailTransferError('SMTP_AUTH_UNAVAILABLE',false);
      // Test sender permission without sending a recipient or message.
      await replies.command(`MAIL FROM:<${username}>`,[250]);
      await replies.command('RSET',[250]);
      return {socket:socket as tls.TLSSocket,replies};
    } catch (error) { replies.detach(); socket.destroy(); throw error; }
  }
  async probe(): Promise<void> {
    let connection: Awaited<ReturnType<TimewebSmtp['connect']>> | undefined;
    try { connection = await this.connect(); await connection.replies.command('QUIT',[221]); }
    finally { connection?.replies.detach(); connection?.socket.destroy(); }
  }
  async send(mail: OutboundMail): Promise<number> {
    if (mail.from !== this.config.username || mail.to !== this.config.recipient || mail.replyTo !== this.config.username) {
      throw new MailTransferError('MAIL_DESTINATION_DENIED',false);
    }
    const bytes = renderMimeMessage(mail); // Validate before connecting.
    let connection: Awaited<ReturnType<TimewebSmtp['connect']>> | undefined;
    let dataStarted = false;
    try {
      connection = await this.connect();
      await connection.replies.command(`MAIL FROM:<${mail.from}>`,[250]);
      await connection.replies.command(`RCPT TO:<${mail.to}>`,[250,251]);
      await connection.replies.command('DATA',[354]);
      dataStarted = true;
      connection.socket.write(`${bytes}\r\n.\r\n`);
      const result = await connection.replies.response();
      if (result.code !== 250) throw new MailTransferError('SMTP_REJECTED',false,result.code);
      return result.code;
    } catch (error) {
      if (error instanceof MailTransferError) throw error;
      throw new MailTransferError(dataStarted ? 'SMTP_RESULT_UNKNOWN' : 'SMTP_CONNECTION_FAILED',dataStarted);
    } finally { connection?.replies.detach(); connection?.socket.destroy(); }
  }
}
