import { mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createRelayServer } from './relay-server.ts';
import { startInboxPoller } from './relay-inbox.ts';
import { TimewebSmtp } from './smtp.ts';
import { validatePublicOrigin } from '../secret-auth.ts';

const token=process.env.MAIL_RELAY_TOKEN;
const password=process.env.MAIL_SMTP_PASSWORD;
const directory=process.env.MAIL_RELAY_LEDGER_DIR;
const port=process.env.MAIL_RELAY_PORT ?? '8085';
const appOrigin=process.env.MAIL_APP_ORIGIN;
const checkedAppOrigin=appOrigin?validatePublicOrigin(appOrigin):null;
if (!token || !/^[0-9a-f]{64}$/.test(token) || !password || !directory || !isAbsolute(directory) ||
    !/^\d+$/.test(port) || Number(port)<1 || Number(port)>65535) {
  throw new Error('Incomplete or invalid VDS mail relay configuration');
}
await mkdir(directory,{recursive:true,mode:0o700});
const smtp=new TimewebSmtp({transport:'smtp',host:'smtp.timeweb.ru',port:465,
  username:'info@ycs.bar',recipient:'r.talyutin@gmail.com',password});
const server=createRelayServer(token,directory,smtp);
server.listen(Number(port),'127.0.0.1',()=>console.log('MAIL_RELAY_LISTENING'));
const stopInbox=checkedAppOrigin ? startInboxPoller({directory,password,token,appOrigin:checkedAppOrigin}) : null;
if (!stopInbox) console.log('MAIL_INBOX_DISABLED');
process.once('SIGTERM',()=>void (async()=>{
  await stopInbox?.();
  server.close();
})());
