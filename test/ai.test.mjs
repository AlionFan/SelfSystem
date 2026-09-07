import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {openStore} from '../server/store.mjs';
import {entrySchema} from '../server/schema.mjs';
import {initializeOwner} from '../server/account-auth.mjs';
import {createAi,normalizeAiResult} from '../server/ai.mjs';
import {createApp} from '../server/app.mjs';
import {createAiSetup,normalizeApiKey} from '../scripts/ai-setup.mjs';
const stamp=Date.parse('2026-09-06T04:00:00Z');
const config={enabled:true,apiKey:'sk-test-only-not-a-real-key',monthlyBudgetYuan:20};
const make=fields=>entrySchema.parse({id:randomUUID(),kind:'note',body:'明天下午开会',captureMode:'auto',capturedAt:'2026-09-06T01:00:00Z',...fields});
const item=(sourceText,fields={})=>({kind:'task',title:'整理标题',sourceText,...fields});
const answer=items=>({items,advice:[]});
const response=result=>({ok:true,status:200,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:1500,completion_tokens:500}})});
function fixture(t,options={}){
  const dir=mkdtempSync(path.join(tmpdir(),'me-ai-')),store=openStore(dir),authConfig={secret:randomBytes(32).toString('base64url'),ownerEmail:'owner@example.test',registration:'open',wechatProvider:'pushplus'},owner=initializeOwner(store,authConfig),other=randomUUID();
  store.db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,?)').run(other,'second@example.test',new Date(stamp).toISOString());
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const ai=createAi({store,config,now:()=>stamp,...options});
  const save=(fields={},user=owner)=>store.forUser(user).mutate({operationId:randomUUID(),baseVersion:0,entry:make(fields)},'test').entry;
  const change=(entry,fields={},user=owner)=>store.forUser(user).mutate({operationId:randomUUID(),baseVersion:entry.version,entry:entrySchema.parse({...make({id:entry.id,body:entry.body,kind:entry.kind}),...fields})},'test').entry;
  return {store,ai,owner,other,save,change,authConfig};
}

test('classification preserves manual category, explicit fields and raw text; vague dates do not invent times',()=>{
  const original=make({body:'明天下午开会'}),raw=answer([item(original.body,{kind:'event',scheduledDate:'2026-09-07',startAt:'2026-09-07T15:00:00+08:00',endAt:'2026-09-07T16:00:00+08:00',reminderAt:'2026-09-07T14:50:00+08:00',timeEvidence:'明天下午',reminderEvidence:'明天下午'})]);
  const event=normalizeAiResult(raw,original,'auto',stamp).entries[0];assert.equal(event.kind,'event');assert.equal(event.scheduledDate,'2026-09-07');assert.equal(event.startAt,null);assert.equal(event.endAt,null);assert.equal(event.reminderAt,null);assert.equal(event.quadrant,null);assert.equal(event.originalBody,original.body);
  const note=normalizeAiResult(raw,original,'note',stamp).entries[0];assert.equal(note.kind,'note');assert.equal(note.scheduledDate,null);
  const manual=make({kind:'event',title:'我的标题',tags:['我的标签'],scheduledDate:'2026-09-08',startAt:'2026-09-08T15:00:00+08:00',endAt:'2026-09-08T17:00:00+08:00',reminderAt:'2026-09-08T14:00:00+08:00',wechatReminder:true});
  const kept=normalizeAiResult(raw,manual,'event',stamp).entries[0];for(const field of ['title','scheduledDate','startAt','endAt','reminderAt','wechatReminder'])assert.equal(kept[field],manual[field]);assert.ok(kept.tags.includes('我的标签'));
  const onlyStart=make({body:'明天9点开会'});assert.equal(normalizeAiResult(answer([item(onlyStart.body,{kind:'event',timeEvidence:onlyStart.body,startAt:'2026-09-07T09:00:00+08:00',endAt:'2026-09-07T10:00:00+08:00'})]),onlyStart,'event',stamp).entries[0].endAt,null);
});

test('explicit reminder and priority evidence are required; generated instructions cannot create arbitrary content',()=>{
  const original=make({body:'重要：明天9点提醒我交论文'}),raw=answer([item(original.body,{dueDate:'2026-09-07',timeEvidence:original.body,reminderAt:'2026-09-07T09:00:00+08:00',reminderEvidence:original.body,important:true,importanceEvidence:'重要'})]);
  const ready=normalizeAiResult(raw,original,'auto',stamp,{wechatAuto:true,connected:true}).entries[0];assert.equal(ready.quadrant,'urgent-important');assert.equal(ready.wechatReminder,true);assert.equal(ready.phase,'todo');
  assert.equal(normalizeAiResult(raw,original,'auto',stamp,{wechatAuto:false,connected:true}).entries[0].wechatReminder,false);
  assert.throws(()=>normalizeAiResult(answer([item('原文没有这一项')]),original,'auto',stamp),/未能对应原文/);
  assert.throws(()=>normalizeAiResult({items:[{...item(original.body),userId:'another-account'}]},original,'auto',stamp));
});

test('Qwen uses the fixed Beijing endpoint, saved reference time and non-thinking JSON; split and undo are atomic',async t=>{
  let requests=0;const raw='明天交论文；周五买牛奶',f=fixture(t,{fetchOverride:async(url,options)=>{requests++;assert.equal(url,'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');const body=JSON.parse(options.body),input=JSON.parse(body.messages[1].content);assert.equal(body.model,'qwen-flash');assert.equal(body.enable_thinking,false);assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(input.timezone,'Asia/Shanghai');assert.match(input.referenceTime,/2026.*9.*6/);assert.equal(input.text,raw);assert.equal(input.userId,undefined);return response(answer([item('明天交论文'),item('周五买牛奶')]));}});
  const e=f.save({body:raw}),job=f.ai.enqueue(f.owner,e);assert.equal(f.ai.enqueue(f.owner,e).id,job.id);await f.ai.tick();await f.ai.tick();assert.equal(requests,1);
  const status=f.ai.status(f.owner);assert.equal(status.jobs[0].state,'applied');assert.equal(status.jobs[0].resultIds.length,2);assert.equal(status.dailyUsed,1);assert.equal(f.store.forUser(f.owner).list().length,2);assert.equal(f.store.forUser(f.other).list().length,0);
  const child=f.store.forUser(f.owner).list().find(v=>v.id!==e.id);assert.equal(child.sourceId,e.id);assert.equal(f.ai.detail(f.owner,child.id).originalBody,raw);
  assert.throws(()=>f.ai.detail(f.other,e.id),e=>e.status===404);assert.throws(()=>f.ai.undo(f.other,job.id),e=>e.status===404);
  f.ai.undo(f.owner,job.id);f.ai.undo(f.owner,job.id);assert.equal(f.store.forUser(f.owner).get(e.id).body,raw);assert.ok(f.store.forUser(f.owner).get(child.id).deletedAt);assert.equal(f.ai.status(f.owner).jobs[0].state,'undone');
});

test('concurrent user edits and opt-out prevent an in-flight AI reply from overwriting data',async t=>{
  for(const cancel of [false,true]){
    let release,started;const ready=new Promise(resolve=>{started=resolve;}),f=fixture(t,{fetchOverride:async()=>{started();return new Promise(resolve=>{release=()=>resolve(response(answer([item('明天下午开会')])));});}}),e=f.save();f.ai.enqueue(f.owner,e);const running=f.ai.tick();await ready;
    if(cancel)f.ai.setPreference(f.owner,{enabled:false});else f.change(e,{body:'我已经手动改好了'});
    release();await running;assert.equal(f.ai.status(f.owner).jobs[0].state,cancel?'cancelled':'stale');assert.equal(f.store.forUser(f.owner).get(e.id).body,cancel?e.body:'我已经手动改好了');
  }
});

test('undo refuses changed children without partially restoring the source; nested writes roll back together',async t=>{
  const f=fixture(t,{fetchOverride:async()=>response(answer([item('甲'),item('乙')]))}),e=f.save({body:'甲；乙'}),job=f.ai.enqueue(f.owner,e);await f.ai.tick();const child=f.store.forUser(f.owner).list().find(v=>v.id!==e.id);f.change(child,{body:'手动改乙'});const version=f.store.forUser(f.owner).get(e.id).version;
  assert.throws(()=>f.ai.undo(f.owner,job.id),e=>e.status===409);assert.equal(f.store.forUser(f.owner).get(e.id).version,version);assert.equal(f.store.forUser(f.owner).get(child.id).body,'手动改乙');
  const extra=make({body:'should roll back'});assert.throws(()=>f.store.transaction(()=>{assert.equal(f.store.forUser(f.owner).mutate({operationId:randomUUID(),baseVersion:0,entry:extra},'test').status,200);throw Error('rollback');}));assert.equal(f.store.forUser(f.owner).get(extra.id),null);
});

test('daily and monetary caps stop calls, uncertain calls retain reservation, and other users must opt in',async t=>{
  let calls=0;const f=fixture(t,{config:{...config,perUserDailyLimit:1},fetchOverride:async()=>{calls++;throw Error('uncertain network response');}});
  const e=f.save();f.ai.enqueue(f.owner,e);await f.ai.tick();assert.equal(calls,1);assert.equal(f.ai.status(f.owner).dailyUsed,1);assert.ok(f.store.db.prepare('SELECT cost_micros FROM ai_usage').get().cost_micros>0);
  f.ai.enqueue(f.owner,e,'task',true);await f.ai.tick();assert.equal(calls,1);assert.match(f.ai.status(f.owner).jobs[0].error,/额度/);
  const other=f.save({},f.other);assert.equal(f.ai.enqueue(f.other,other).state,'cancelled');f.ai.setPreference(f.other,{enabled:true});assert.equal(f.ai.enqueue(f.other,other,'event',true).state,'pending');await f.ai.tick();assert.equal(calls,2);
  const g=fixture(t,{config:{...config,monthlyBudgetYuan:0},fetchOverride:async()=>{throw Error('must not call');}});g.ai.enqueue(g.owner,g.save());await g.ai.tick();assert.match(g.ai.status(g.owner).jobs[0].error,/额度/);assert.equal(g.ai.status(g.owner).dailyUsed,0);
});

test('interrupted AI attempts are exposed for manual retry, not automatically billed twice',async t=>{
  let calls=0;const f=fixture(t,{fetchOverride:async()=>{calls++;return response(answer([item('明天下午开会')]));}}),e=f.save(),job=f.ai.enqueue(f.owner,e);
  f.store.db.prepare("UPDATE ai_jobs SET state='running',updated_at=? WHERE id=?").run(new Date(stamp-180000).toISOString(),job.id);await f.ai.tick();assert.equal(calls,0);assert.equal(f.ai.status(f.owner).jobs[0].state,'failed');f.ai.enqueue(f.owner,e,'event',true);await f.ai.tick();assert.equal(calls,1);assert.equal(f.store.forUser(f.owner).get(e.id).kind,'event');
});

test('authenticated APIs isolate AI jobs and personal receipts, reject unsafe writes, and opt in with consent',async t=>{
  const f=fixture(t),mails=[];f.store.db.prepare('DELETE FROM users WHERE id=?').run(f.other);const {app,ai,wechat}=createApp({store:f.store,accountConfig:f.authConfig,aiConfig:config,origin:'http://127.0.0.1',secureCookies:false,sendMailOverride:async m=>mails.push(m),aiFetchOverride:async()=>response(answer([item('明天下午开会')])),wechatFetchOverride:async()=>({ok:true,json:async()=>({code:200,data:'fixture'})})});
  const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
  async function req(url,{user,method='GET',body,csrf=true}={}){const r=await fetch(base+url,{method,headers:{...(user?{Cookie:user.cookie}:{}),...(body?{'Content-Type':'application/json',Origin:'http://127.0.0.1',...(csrf&&user?{'X-Me-CSRF':user.csrf}:{})}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  async function register(email){await req('/api/auth/email-code',{method:'POST',body:{email,purpose:'register'}});const r=await req('/api/auth/register',{method:'POST',body:{email,code:mails.at(-1).code,password:'A good preview password!'}});assert.equal(r.status,201);return {cookie:r.cookie,csrf:r.data.csrf,id:r.data.user.id};}
  const owner=await register('owner@example.test'),other=await register('second@example.test');assert.equal((await req('/api/ai')).status,401);assert.equal((await req('/api/ai',{user:other})).data.enabled,false);
  assert.equal((await req('/api/ai/preferences',{user:other,method:'PATCH',body:{enabled:true}})).status,400);assert.equal((await req('/api/ai/preferences',{user:other,method:'PATCH',body:{enabled:true,consent:true},csrf:false})).status,403);
  assert.equal((await req('/api/ai/preferences',{user:other,method:'PATCH',body:{enabled:true,consent:true}})).status,200);
  const e=f.save(),job=ai.enqueue(owner.id,e);await ai.tick();assert.equal((await req(`/api/ai/entries/${e.id}`,{user:other})).status,404);assert.equal((await req(`/api/ai/jobs/${job.id}/undo`,{user:other,method:'POST',body:{}})).status,404);
  assert.equal((await req(`/api/ai/entries/${e.id}/analyze`,{user:other,method:'POST',body:{version:1,kind:'auto'}})).status,404);
  wechat.bind(owner.id,'a'.repeat(32));const delivery=await wechat.sendNow(owner.id,e.id);assert.equal((await req(`/api/reminders/${delivery.id}`,{user:other})).status,404);assert.equal((await req(`/api/reminders/${delivery.id}/action`,{user:other,method:'POST',body:{action:'done',version:2}})).status,404);
  assert.equal((await req(`/api/reminders/${delivery.id}/action`,{user:owner,method:'POST',body:{action:'done',version:2},csrf:false})).status,403);assert.equal((await req(`/api/reminders/${delivery.id}`,{user:owner})).data.response,null);
});

test('local AI setup rejects forged origins and stale forms, stores privately and never echoes a key',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'me-ai-form-')),configPath=path.join(dir,'ai.json'),server=createAiSetup({configPath,port:0});server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,html=await (await fetch(base)).text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1],fields={csrf,apiKey:'sk-test-only-not-a-real-key'};
  async function post(body=fields,origin=base){const r=await fetch(base+'/save',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,text:await r.text()};}
  assert.equal((await post(fields,'null')).status,403);assert.equal((await post({...fields,csrf:'stale'})).status,403);assert.equal(existsSync(configPath),false);
  const saved=await post();assert.equal(saved.status,200);assert.equal(saved.text.includes(fields.apiKey),false);assert.equal(JSON.parse(readFileSync(configPath)).apiKey,fields.apiKey);assert.equal(statSync(configPath).mode&0o777,0o600);assert.equal((await (await fetch(base)).text()).includes(fields.apiKey),false);
});

test('AI output preserves manual time fields and cannot infer exact clock time from an afternoon',()=>{
  const raw=make({body:'明天下午处理文稿'});
  const result=normalizeAiResult(answer([item(raw.body,{scheduledDate:'2026-09-07',scheduledTime:'15:00',dueTime:'18:00',timeEvidence:'明天下午'})]),raw,'task',stamp).entries[0];
  assert.equal(result.scheduledDate,'2026-09-07');assert.equal(result.scheduledTime,null);assert.equal(result.dueTime,null);
  const manual=make({kind:'task',body:raw.body,scheduledTime:'09:30',dueTime:'18:00'}),kept=normalizeAiResult(answer([item(raw.body)]),manual,'task',stamp).entries[0];assert.equal(kept.scheduledTime,'09:30');assert.equal(kept.dueTime,'18:00');
  const event=make({kind:'event',body:raw.body,startTime:'09:00',endTime:'10:00'});const changed=normalizeAiResult(answer([item(raw.body)]),event,'auto',stamp).entries[0];assert.equal(changed.kind,'task');assert.equal(changed.startTime,null);assert.equal(changed.endTime,null);
});

test('offline retries across schema upgrades remain idempotent without accepting altered requests',t=>{
  const f=fixture(t),old=make({body:'升级前已保存但响应丢失'});
  for(const key of ['captureMode','capturedAt','originalBody','aiSummary','quadrant','phase','scheduledTime','dueTime','startTime','endTime'])delete old[key];
  const operation={operationId:randomUUID(),baseVersion:0,entry:old};assert.equal(f.store.forUser(f.owner).mutate(operation,'test').status,200);
  const upgraded={...operation,entry:entrySchema.parse(old)};assert.equal(f.store.forUser(f.owner).mutate(upgraded,'test').entry.version,1);assert.equal(f.store.forUser(f.owner).list().length,1);
  assert.equal(f.store.forUser(f.owner).mutate({...upgraded,entry:{...upgraded.entry,body:'different'}},'test').status,409);
  const stolen=f.store.forUser(f.other).mutate(upgraded,'test');assert.equal(stolen.status,409);assert.equal(stolen.entry,undefined);
});


test('credential setup accepts opaque long encodings and copy wrappers without silently changing the secret',()=>{
  const key='future-format.'+'aB09_-/+=' .repeat(100);
  assert.equal(normalizeApiKey('  '+key+'\n'),key);
  assert.equal(normalizeApiKey('"'+key+'"'),key);
  assert.equal(normalizeApiKey('Bearer '+key),key);
  assert.equal(normalizeApiKey('sk-'+'A'.repeat(32)), 'sk-'+'A'.repeat(32));
  for(const input of ['',null,'sk-****1234567890123456','sk-abc...1234567890','sk-1234\r\nAuthorization: bad','sk-１２３4567890123456789','a'.repeat(4097)])assert.throws(()=>normalizeApiKey(input));
});

test('long credentials are saved intact; invalid resubmissions preserve the saved configuration',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'me-ai-long-key-')),configPath=path.join(dir,'ai.json'),server=createAiSetup({configPath,port:0});server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,html=await (await fetch(base)).text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  assert.doesNotMatch(html,/maxlength="256"|minlength="20"/);
  const key='fixture.'+'aB09_-/+=' .repeat(300);
  const post=apiKey=>fetch(base+'/save',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({csrf,apiKey})});
  const result=await post('"'+key+'"');assert.equal(result.status,200);assert.equal((await result.text()).includes(key),false);assert.equal(JSON.parse(readFileSync(configPath)).apiKey,key);
  const before=readFileSync(configPath,'utf8'),masked=await post('sk-********masked123456789');assert.equal(masked.status,400);assert.match((await masked.json()).error,/复制按钮/);assert.equal(readFileSync(configPath,'utf8'),before);
  const broken=await post('a'.repeat(4097));assert.equal(broken.status,400);assert.equal(readFileSync(configPath,'utf8'),before);
});
