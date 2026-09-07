import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {openStore} from '../server/store.mjs';
import {entrySchema} from '../server/schema.mjs';
import {initializeOwner} from '../server/account-auth.mjs';
import {createApp} from '../server/app.mjs';
import {createWechat} from '../server/wechat.mjs';
import {createPush} from '../server/push.mjs';

function setup(t){const dir=mkdtempSync(path.join(tmpdir(),'me-accounts-')),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
const entry=fields=>entrySchema.parse({id:randomUUID(),kind:'note',body:'只有所属账号可见',...fields});
const op=(e,baseVersion=0)=>({operationId:randomUUID(),baseVersion,entry:e});
const config=()=>({secret:randomBytes(32).toString('base64url'),ownerEmail:'owner@example.test',registration:'open',wechatProvider:'pushplus'});

test('legacy content is assigned to the reserved owner; repeated migration preserves ownership',t=>{
  const store=setup(t),e=entry({wechatReminder:false}),operation=op(e);store.mutate(operation,'legacy');const cfg=config(),owner=initializeOwner(store,cfg);
  assert.equal(store.forUser(owner).get(e.id).body,e.body);assert.equal(store.forUser('stranger').list().length,0);assert.equal(initializeOwner(store,cfg),owner);
  assert.equal(store.forUser(owner).mutate(operation,'legacy').entry.version,1);
});

test('email proof, public registration, sessions, CSRF and cross-account boundaries work end to end',async t=>{
  const store=setup(t),legacy=entry();store.mutate(op(legacy),'old');const cfg=config(),ownerId=initializeOwner(store,cfg),mails=[];
  const {app}=createApp({store,accountConfig:cfg,origin:'http://127.0.0.1',secureCookies:false,sendMailOverride:async message=>mails.push(message)});
  const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(url,{method='GET',body,cookie,csrf,account,origin='http://127.0.0.1'}={}){const response=await fetch(base+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:origin}:{}),...(csrf?{'X-Me-CSRF':csrf}:{}),...(account?{'X-Me-Account':account}:{})},body:body?JSON.stringify(body):undefined});let data;try{data=await response.json();}catch{}return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],setCookie:response.headers.get('set-cookie')};}
  async function register(email){assert.equal((await request('/api/auth/email-code',{method:'POST',body:{email,purpose:'register'}})).status,200);const code=mails.at(-1).code;const result=await request('/api/auth/register',{method:'POST',body:{email,password:'A secure account password!',code}});assert.equal(result.status,201);return {...result,id:result.data.user.id,csrf:result.data.csrf};}
  assert.equal((await request('/api/entries')).status,401);assert.equal((await request('/api/auth/status')).data.authenticated,false);
  assert.equal((await request('/api/auth/register',{method:'POST',body:{email:'owner@example.test',password:'Long Password 123',code:'000000'}})).status,400);
  const owner=await register('owner@example.test'),other=await register('second@example.test');assert.equal(owner.id,ownerId);assert.match(owner.setCookie,/HttpOnly/);assert.match(owner.setCookie,/SameSite=Lax/);
  assert.equal((await request('/api/entries',{cookie:owner.cookie})).data.entries.length,1);assert.deepEqual((await request('/api/entries',{cookie:other.cookie})).data.entries,[]);
  const ownedOp=op(entry()),created=await request('/api/mutations',{method:'POST',body:ownedOp,cookie:owner.cookie,csrf:owner.csrf,account:owner.id});assert.equal(created.status,200);
  assert.equal((await request('/api/mutations',{method:'POST',body:op(entry()),cookie:owner.cookie})).status,403);
  assert.equal((await request('/api/mutations',{method:'POST',body:op(entry()),cookie:owner.cookie,csrf:owner.csrf,origin:'https://evil.test'})).status,403);
  assert.equal((await request('/api/mutations',{method:'POST',body:op(entry()),cookie:other.cookie,csrf:other.csrf,account:owner.id})).status,409);
  const stolen=await request('/api/mutations',{method:'POST',body:ownedOp,cookie:other.cookie,csrf:other.csrf});assert.equal(stolen.status,409);assert.equal(stolen.data.entry,undefined);
  assert.equal((await request('/api/mutations',{method:'POST',body:op({...ownedOp.entry,body:'attempt overwrite'},1),cookie:other.cookie,csrf:other.csrf})).status,404);
  assert.equal((await request('/api/mutations',{method:'POST',body:op(entry({kind:'task',sourceId:legacy.id})),cookie:other.cookie,csrf:other.csrf})).status,400);
  assert.equal((await request(`/api/export?account=${other.id}`,{cookie:other.cookie})).data.entries.length,0);
  assert.equal((await request(`/api/export?account=${owner.id}`,{cookie:other.cookie})).status,403);
  assert.equal((await request('/api/import',{method:'POST',body:store.forUser(owner.id).exportData(),cookie:other.cookie,csrf:other.csrf})).status,400);
  const ownDevices=(await request('/api/devices',{cookie:owner.cookie})).data.devices;assert.equal(ownDevices.length,1);
  assert.equal((await request(`/api/devices/${ownDevices[0].id}`,{method:'PATCH',body:{revoke:true},cookie:other.cookie,csrf:other.csrf})).status,404);
  assert.equal((await request('/api/wechat/send',{method:'POST',body:{entryId:legacy.id},cookie:other.cookie,csrf:other.csrf})).status,400);
  const repeated=await request('/api/auth/login',{method:'POST',body:{email:'owner@example.test',password:'A secure account password!'}});assert.equal(repeated.status,200);assert.notEqual(repeated.cookie,owner.cookie);
  assert.equal((await request(`/api/devices/${ownDevices[0].id}`,{method:'PATCH',body:{revoke:true},cookie:repeated.cookie,csrf:repeated.data.csrf})).status,200);assert.equal((await request('/api/entries',{cookie:owner.cookie})).status,401);
  assert.equal((await request('/api/auth/logout',{method:'POST',body:{},cookie:other.cookie,csrf:other.csrf})).status,200);assert.equal((await request('/api/entries',{cookie:other.cookie})).status,401);
  // Advance the email resend window without weakening production verification.
  store.db.prepare('DELETE FROM auth_limits').run();
  assert.equal((await request('/api/auth/email-code',{method:'POST',body:{email:'owner@example.test',purpose:'reset'}})).status,200);
  const resetCode=mails.at(-1).code;assert.equal((await request('/api/auth/reset-password',{method:'POST',body:{email:'owner@example.test',password:'A changed password 123!',code:resetCode}})).status,200);
  assert.equal((await request('/api/entries',{cookie:repeated.cookie})).status,401);
  assert.equal((await request('/api/auth/reset-password',{method:'POST',body:{email:'owner@example.test',password:'Another password 123!',code:resetCode}})).status,400);
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'owner@example.test',password:'A changed password 123!'}})).status,200);
});

test('WeChat uses the entry owner token, escapes content, deduplicates schedules and verifies callbacks',async t=>{
  const store=setup(t),cfg=config(),a=initializeOwner(store,cfg),b=randomUUID(),stamp=Date.now(),requests=[];
  store.db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,?)').run(b,'other@example.test',new Date(stamp).toISOString());
  const send=async(url,options)=>{assert.equal(url,'https://www.pushplus.plus/send');const body=JSON.parse(options.body);requests.push(body);return {ok:true,json:async()=>({code:200,data:'result-'+requests.length})};};
  const wx=createWechat({store,secret:cfg.secret,enabled:true,now:()=>stamp,fetchOverride:send});wx.bind(a,'a'.repeat(32));wx.bind(b,'b'.repeat(32));
  const ea=entry({body:'<script>alert(1)</script> 私密甲',wechatReminder:true,reminderAt:new Date(stamp-1000).toISOString()}),eb=entry({body:'私密乙',wechatReminder:true,reminderAt:new Date(stamp-1000).toISOString()});store.forUser(a).mutate(op(ea),'a');store.forUser(b).mutate(op(eb),'b');
  await wx.tick();await createWechat({store,secret:cfg.secret,enabled:true,now:()=>stamp,fetchOverride:send}).tick();assert.equal(requests.length,2);assert.ok(requests.find(r=>r.token==='a'.repeat(32)).content.includes('&lt;script&gt;'));assert.ok(!requests.find(r=>r.token==='b'.repeat(32)).content.includes('私密甲'));
  assert.ok(!store.db.prepare('SELECT encrypted_token FROM wechat_bindings WHERE user_id=?').get(a).encrypted_token.includes('a'.repeat(32)));
  const callbackToken=new URL(requests[0].callbackUrl).pathname.split('/').at(-1);assert.equal(wx.callback('x'.repeat(43),{event:'message_complate',messageInfo:{shortCode:'result-1',sendStatus:2}}),false);
  assert.equal(wx.callback(callbackToken,{event:'message_complate',messageInfo:{shortCode:'wrong',sendStatus:2}}),false);assert.equal(wx.callback(callbackToken,{event:'message_complate',messageInfo:{shortCode:'result-1',sendStatus:2}}),true);
  const testResult=await wx.sendNow(a);assert.equal(testResult.state,'queued');wx.unbind(a);assert.equal(wx.status(a).connected,false);
  await assert.rejects(()=>wx.sendNow(b,ea.id),/记录不存在/);
});

test('uncertain WeChat submissions are not blindly retried, and completed entries do not send',async t=>{
  const store=setup(t),cfg=config(),user=initializeOwner(store,cfg),stamp=Date.now();let sends=0;
  const wx=createWechat({store,secret:cfg.secret,enabled:true,now:()=>stamp,fetchOverride:async()=>{sends++;throw new Error('network timeout');}});wx.bind(user,'t'.repeat(32));
  const e=entry({wechatReminder:true,reminderAt:new Date(stamp-1000).toISOString()});store.forUser(user).mutate(op(e),'test');await wx.tick();await wx.tick();assert.equal(sends,1);assert.equal(wx.status(user).deliveries[0].state,'unknown');
  const done=entry({status:'done',wechatReminder:true,reminderAt:new Date(stamp-1000).toISOString()});store.forUser(user).mutate(op(done),'test');await wx.tick();assert.equal(sends,1);
});

test('browser push subscriptions cannot receive another account content',async t=>{
  const store=setup(t),cfg=config(),a=initializeOwner(store,cfg),b=randomUUID(),stamp=Date.now(),received=[];store.db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,?)').run(b,'b@example.test',new Date(stamp).toISOString());
  for(const [id,user] of [['a',a],['b',b]]){store.db.prepare('INSERT INTO devices(id,name,fingerprint,user_id,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(id,id,id,user,new Date(stamp).toISOString(),'2099-01-01T00:00:00Z');const endpoint='https://fcm.googleapis.com/'+id;store.db.prepare('INSERT INTO subscriptions VALUES (?,?,?,?)').run(endpoint,id,JSON.stringify({endpoint}),new Date(stamp).toISOString());}
  store.forUser(a).mutate(op(entry({kind:'task',reminderAt:new Date(stamp-1000).toISOString()})),'a');await createPush({store,now:()=>stamp,sendOverride:async sub=>received.push(sub.endpoint)}).tick();assert.deepEqual(received,['https://fcm.googleapis.com/a']);
});

test('provider account restrictions pause delivery without retries or flooding later jobs',async t=>{
  const store=setup(t),cfg=config(),user=initializeOwner(store,cfg),stamp=Date.now();let sends=0;
  const wx=createWechat({store,secret:cfg.secret,enabled:true,now:()=>stamp,fetchOverride:async()=>{sends++;return {ok:true,json:async()=>({code:900})};}});wx.bind(user,'t'.repeat(32));
  for(let i=0;i<3;i++)store.forUser(user).mutate(op(entry({wechatReminder:true,reminderAt:new Date(stamp-1000).toISOString()})),'test');
  await wx.tick();await wx.tick();assert.equal(sends,1);assert.equal(wx.status(user).connected,false);assert.ok(wx.status(user).deliveries.some(d=>d.state==='failed'));
});

test('a verified callback arriving before the send response is preserved',async t=>{
  const store=setup(t),cfg=config(),user=initializeOwner(store,cfg);
  const wx=createWechat({store,secret:cfg.secret,enabled:true,fetchOverride:async(_,options)=>{const body=JSON.parse(options.body),token=new URL(body.callbackUrl).pathname.split('/').at(-1);assert.equal(wx.callback(token,{event:'message_complate',messageInfo:{shortCode:'early-result',sendStatus:2}}),true);return {ok:true,json:async()=>({code:200,data:'early-result'})};}});wx.bind(user,'t'.repeat(32));
  assert.equal((await wx.sendNow(user)).state,'delivered');
});

test('personal receipts distinguish acknowledgement, completion and snooze and are safe to repeat',async t=>{
  const store=setup(t),cfg=config(),owner=initializeOwner(store,cfg),other=randomUUID();let stamp=Date.now();const requests=[];
  store.db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,?)').run(other,'other@example.test',new Date(stamp).toISOString());
  const wx=createWechat({store,secret:cfg.secret,enabled:true,now:()=>stamp,fetchOverride:async(_,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({code:200,data:'receipt-'+requests.length})};}});wx.bind(owner,'t'.repeat(32));
  const e=entry({kind:'task',body:'处理回执的测试',reminderAt:new Date(stamp-1000).toISOString(),wechatReminder:true});store.forUser(owner).mutate(op(e),'test');await wx.tick();const delivery=wx.status(owner).deliveries[0];assert.match(requests[0].content,new RegExp('reminder='+delivery.id));assert.throws(()=>wx.receipt(other,delivery.id),e=>e.status===404);
  assert.equal(wx.receipt(owner,delivery.id).response,null);assert.throws(()=>wx.respond(owner,delivery.id,{action:'done',version:99}),e=>e.status===409);
  wx.respond(owner,delivery.id,{action:'acknowledged',version:1});assert.equal(store.forUser(owner).get(e.id).status,'active');assert.equal(store.forUser(owner).get(e.id).version,1);
  const snoozed=wx.respond(owner,delivery.id,{action:'snoozed',version:1,minutes:15});assert.equal(snoozed.response.snoozeUntil,new Date(stamp+15*60000).toISOString());const version=snoozed.entry.version;
  stamp+=60000;const repeated=wx.respond(owner,delivery.id,{action:'snoozed',version:1,minutes:60});assert.equal(repeated.entry.version,version);assert.equal(repeated.response.snoozeUntil,snoozed.response.snoozeUntil);
  // A message without a callback is explicitly unknown; a late verified callback can still settle it.
  stamp+=5*60000;await wx.tick();assert.equal(wx.receipt(owner,delivery.id).delivery.state,'unknown');const callback=new URL(requests[0].callbackUrl).pathname.split('/').at(-1);assert.equal(wx.callback(callback,{event:'message_complate',messageInfo:{shortCode:'receipt-1',sendStatus:2}}),true);assert.equal(wx.receipt(owner,delivery.id).delivery.state,'delivered');
  stamp+=10*60000;await wx.tick();assert.equal(requests.length,2);const next=wx.status(owner).deliveries.find(d=>d.id!==delivery.id);const done=wx.respond(owner,next.id,{action:'done',version});assert.equal(done.entry.status,'done');assert.equal(done.response.action,'done');wx.respond(owner,next.id,{action:'done',version});assert.equal(store.forUser(owner).get(e.id).version,done.entry.version);await wx.tick();assert.equal(requests.length,2);
});

test('outdated reminder links cannot complete rescheduled tasks, and notes only acknowledge or snooze',async t=>{
  const store=setup(t),cfg=config(),owner=initializeOwner(store,cfg),stamp=Date.now();const wx=createWechat({store,secret:cfg.secret,enabled:true,now:()=>stamp,fetchOverride:async()=>({ok:true,json:async()=>({code:200,data:'old-reminder'})})});wx.bind(owner,'t'.repeat(32));
  const e=entry({kind:'task',wechatReminder:true,reminderAt:new Date(stamp-1000).toISOString()});store.forUser(owner).mutate(op(e),'test');await wx.tick();const d=wx.status(owner).deliveries[0];store.forUser(owner).mutate(op({...e,reminderAt:new Date(stamp+3600000).toISOString()},1),'test');assert.throws(()=>wx.respond(owner,d.id,{action:'done',version:2}),e=>e.status===409);assert.equal(store.forUser(owner).get(e.id).status,'active');
  const note=entry();store.forUser(owner).mutate(op(note),'test');const n=await wx.sendNow(owner,note.id);assert.throws(()=>wx.respond(owner,n.id,{action:'done',version:1}),e=>e.status===400);wx.respond(owner,n.id,{action:'acknowledged',version:1});assert.equal(store.forUser(owner).get(note.id).status,'active');wx.unbind(owner);assert.throws(()=>wx.respond(owner,n.id,{action:'snoozed',version:1,minutes:15}),/重新连接/);
});
