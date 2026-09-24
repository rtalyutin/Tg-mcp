import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import net, {type Socket} from 'node:net';
import {TimewebSmtp} from '../src/outreach/smtp.ts';

test('SMTP probe finishes when a connection attempt times out without an error event',async t=>{
  class SilentSocket extends EventEmitter {
    destroyed=false;
    setTimeout(_ms:number,callback:()=>void) { setTimeout(callback,1); return this; }
    destroy(error?:Error) {
      this.destroyed=true;
      queueMicrotask(()=>{ if (error) this.emit('error',error); this.emit('close'); });
      return this;
    }
  }
  const socket=new SilentSocket();
  const connect=net.connect;
  net.connect=(()=>socket as unknown as Socket) as typeof net.connect;
  t.after(()=>{ net.connect=connect; });
  const outcome=await Promise.race([
    new TimewebSmtp({host:'smtp.timeweb.ru',port:587,username:'info@ycs.bar',
      password:'synthetic',recipient:'r.talyutin@gmail.com'}).probe()
      .then(()=>'unexpected success',(error:Error)=>error.message),
    new Promise<string>(resolve=>setTimeout(()=>resolve('still pending'),100)),
  ]);
  assert.equal(outcome,'SMTP_CONNECTION_TIMEOUT');
  assert.equal(socket.destroyed,true);
});
