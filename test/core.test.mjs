import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {openStore} from '../server/store.mjs';
import {entrySchema,mutationSchema} from '../server/schema.mjs';
import {createAuth} from '../server/auth.mjs';
import {createPush,validPushEndpoint} from '../server/push.mjs';

const temp=()=>mkdtempSync(path.join(tmpdir(),'me-test-'));
function setup(t){const dir=temp(),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
const entry=(overrides={})=>entrySchema.parse({id:randomUUID(),kind:'note',body:'一条中文想法',...overrides});
const mutation=(e,baseVersion=0)=>({operationId:randomUUID(),entry:e,baseVersion});

test('offline operation retries are idempotent and conflicting device edits do not overwrite',t=>{
  const store=setup(t),e=entry(),op=mutation(e);assert.equal(store.mutate(op,'test').status,200);assert.equal(store.mutate(op,'test').entry.version,1);assert.equal(store.list().length,1);
  assert.equal(store.mutate({...op,entry:{...e,body:'篡改重放'}},'test').status,409);
  assert.equal(store.mutate(mutation({...e,body:'电脑更新'},1),'test').entry.version,2);
  const conflict=store.mutate(mutation({...e,body:'手机离线内容'},1),'test');assert.equal(conflict.status,409);assert.equal(conflict.current.body,'电脑更新');
});
test('sequential queued edits, deletion and restore retain version history',t=>{
  const store=setup(t),e=entry();store.mutate(mutation(e),'test');
  const removed={...e,deletedAt:new Date().toISOString()};assert.equal(store.mutate(mutation(removed,1),'test').entry.version,2);
  assert.equal(store.mutate(mutation(e,2),'test').entry.deletedAt,null);assert.equal(store.list().length,1);
});
test('export/import round trip preserves links and does not overwrite existing records',t=>{
  const a=setup(t),b=setup(t),note=entry(),task=entry({kind:'task',body:'落实想法',sourceId:note.id,scheduledDate:'2026-09-06',dueDate:'2026-09-08'});a.mutate(mutation(note),'test');a.mutate(mutation(task),'test');
  const data=a.exportData();assert.equal(b.importEntries(data.entries,'test').imported,2);assert.equal(b.get(task.id).sourceId,note.id);assert.equal(b.importEntries(data.entries,'test').skipped,2);
  const bad=[{entry:entry(),createdAt:new Date().toISOString()},{entry:entry({sourceId:randomUUID()}),createdAt:new Date().toISOString()}];assert.throws(()=>b.importEntries(bad,'test'));assert.equal(b.list().length,2);
});
test('dates and input shape are validated, and SQL-like content remains literal',t=>{
  assert.equal(entrySchema.safeParse({id:randomUUID(),kind:'task',body:'x',dueDate:'2026-02-31'}).success,false);
  assert.equal(entrySchema.safeParse({id:randomUUID(),kind:'task',body:'x',scheduledTime:'09:30',dueTime:'18:00'}).success,true);
  assert.equal(entrySchema.safeParse({id:randomUUID(),kind:'task',body:'x',scheduledTime:'09:30',durationMinutes:90}).success,true);
  assert.equal(entrySchema.safeParse({id:randomUUID(),kind:'task',body:'x',durationMinutes:0}).success,false);
  assert.equal(entrySchema.safeParse({id:randomUUID(),kind:'note',body:'x',durationMinutes:30}).success,false);
  assert.equal(entrySchema.safeParse({id:randomUUID(),kind:'task',body:'x',scheduledTime:'24:00'}).success,false);
  assert.equal(entrySchema.safeParse({id:randomUUID(),kind:'note',body:'x',scheduledTime:'09:30'}).success,false);
  assert.equal(entrySchema.safeParse({id:randomUUID(),kind:'event',body:'x',startTime:'09:30'}).success,true);
  assert.equal(entrySchema.safeParse({id:randomUUID(),kind:'event',body:'x',startAt:'2026-09-06T12:00:00Z',endAt:'2026-09-06T11:00:00Z'}).success,false);
  assert.equal(entrySchema.safeParse({id:randomUUID(),kind:'note',body:'x',reminderAt:'2026-09-06T12:00:00Z'}).success,true);
  const store=setup(t),e=entry({body:"'); DROP TABLE entries; -- <script>alert(1)</script>"});store.mutate(mutation(e),'test');assert.equal(store.get(e.id).body,e.body);
});
test('mTLS authorization rejects missing proof, untrusted proxy and revoked devices on every request',t=>{
  const store=setup(t),dir=temp();t.after(()=>rmSync(dir,{recursive:true,force:true}));const run=args=>execFileSync('openssl',args,{stdio:'pipe'});
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${dir}/ca.key`,'-out',`${dir}/ca.pem`,'-days','1','-subj','/CN=Test CA']);
  run(['req','-newkey','rsa:2048','-nodes','-keyout',`${dir}/client.key`,'-out',`${dir}/client.csr`,'-subj','/CN=Test Device']);
  writeFileSync(`${dir}/ext`,'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\nbasicConstraints=CA:FALSE');
  run(['x509','-req','-in',`${dir}/client.csr`,'-CA',`${dir}/ca.pem`,'-CAkey',`${dir}/ca.key`,'-set_serial','1','-days','1','-extfile',`${dir}/ext`,'-out',`${dir}/client.pem`]);
  const cert=new X509Certificate(readFileSync(`${dir}/client.pem`)),secret='a'.repeat(48);store.db.prepare('INSERT INTO devices(id,name,fingerprint,created_at,expires_at) VALUES (?,?,?,?,?)').run('test','测试设备',cert.fingerprint256,new Date().toISOString(),new Date(cert.validTo).toISOString());
  const auth=createAuth({store,mode:'proxy-mtls',caFile:`${dir}/ca.pem`,proxySecret:secret,csrfSecret:'csrf',origin:'https://me.joybeat.cn'});
  function call(headers){const req={get:key=>headers[key]},res={status(n){this.code=n;return this;},send(){}};let passed=false;auth.authenticate(req,res,()=>passed=true);return {passed,code:res.code};}
  const headers={'x-me-proxy-secret':secret,'x-forwarded-tls-client-cert':cert.raw.toString('base64')};assert.equal(call({}).code,403);assert.equal(call({...headers,'x-me-proxy-secret':'wrong'}).code,403);assert.equal(call(headers).passed,true);
  assert.equal(call({...headers,'x-forwarded-tls-client-cert':new X509Certificate(readFileSync(`${dir}/ca.pem`)).raw.toString('base64')}).code,403);
  store.db.prepare('UPDATE devices SET active=0').run();assert.equal(call(headers).code,403);
  const req={method:'POST',device:{id:'test'},get:key=>({'origin':'https://evil.test','x-me-csrf':auth.csrf('test')})[key],is:()=>true},res={status(n){this.code=n;return this;},json(){}};auth.protectMutation(req,res,()=>assert.fail('cross-origin mutation passed'));assert.equal(res.code,403);
});
test('reminders survive worker restarts without duplicate successful sends and respect cancellations',async t=>{
  const store=setup(t),stamp=Date.now(),device='device',endpoint='https://fcm.googleapis.com/test';store.db.prepare('INSERT INTO devices(id,name,fingerprint,created_at,expires_at) VALUES (?,?,?,?,?)').run(device,'test','test',new Date().toISOString(),'2099-01-01T00:00:00Z');store.db.prepare('INSERT INTO subscriptions VALUES (?,?,?,?)').run(endpoint,device,JSON.stringify({endpoint}),new Date().toISOString());
  const e=entry({kind:'task',reminderAt:new Date(stamp-1000).toISOString()});store.mutate(mutation(e),device);let count=0;const options={store,now:()=>stamp,sendOverride:async()=>{count++;}};
  await createPush(options).tick();await createPush(options).tick();assert.equal(count,1);
  const second=entry({kind:'task',reminderAt:new Date(stamp-2000).toISOString()});store.mutate(mutation(second),device);store.mutate(mutation({...second,status:'done'},1),device);await createPush(options).tick();assert.equal(count,1);
});
test('push endpoints cannot target local services or arbitrary external URLs',()=>{
  assert.equal(validPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'),true);assert.equal(validPushEndpoint('https://web.push.apple.com/abc'),true);
  for(const url of ['http://127.0.0.1','https://169.254.169.254','https://fcm.googleapis.com.evil.com','https://fcm.googleapis.com:444','https://a:b@fcm.googleapis.com','https://example.com'])assert.equal(validPushEndpoint(url),false);
});
test('reopening an unsent reminder resumes delivery without resending completed deliveries',async t=>{
  const store=setup(t),stamp=Date.now(),device='resume-test',endpoint='https://fcm.googleapis.com/resume';
  store.db.prepare('INSERT INTO devices(id,name,fingerprint,created_at,expires_at) VALUES (?,?,?,?,?)').run(device,'test','resume',new Date().toISOString(),'2099-01-01T00:00:00Z');
  store.db.prepare('INSERT INTO subscriptions VALUES (?,?,?,?)').run(endpoint,device,JSON.stringify({endpoint}),new Date().toISOString());
  const e=entry({kind:'task',reminderAt:new Date(stamp-1000).toISOString()});store.mutate(mutation(e),device);
  await createPush({store,now:()=>stamp,sendOverride:async()=>{throw new Error('offline');}}).tick();
  store.mutate(mutation({...e,status:'done'},1),device);store.mutate(mutation(e,2),device);
  let sent=0;await createPush({store,now:()=>stamp,sendOverride:async()=>sent++}).tick();assert.equal(sent,1);
  store.mutate(mutation({...e,status:'done'},3),device);store.mutate(mutation(e,4),device);
  await createPush({store,now:()=>stamp,sendOverride:async()=>sent++}).tick();assert.equal(sent,1);
});
