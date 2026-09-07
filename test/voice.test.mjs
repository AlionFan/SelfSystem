import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {openStore} from '../server/store.mjs';
import {initializeOwner} from '../server/account-auth.mjs';
import {createVoice} from '../server/voice.mjs';
import {createAi} from '../server/ai.mjs';
import {createApp} from '../server/app.mjs';
import {entrySchema} from '../server/schema.mjs';
import {encodeVoiceWav,inspectVoiceWav} from '../server/voice-audio.mjs';
import {startMicrophone,appendTranscript,requestTranscript} from '../src/voice.js';

const audio=seconds=>Buffer.from(encodeVoiceWav(Float32Array.from({length:16000*seconds},(_,i)=>Math.sin(i/10)*0.2)));
const input=(seconds=1)=>({id:randomUUID(),audio:audio(seconds).toString('base64'),consent:true});
const answer=text=>({ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:text}}]})});
function setup(t){const dir=mkdtempSync('/tmp/me-voice-test-'),store=openStore(dir),config={secret:randomBytes(32).toString('base64url'),ownerEmail:'owner@example.test',registration:'open'},user=initializeOwner(store,config),other=randomUUID();store.db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,?)').run(other,'other@example.test',new Date().toISOString());t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,config,user,other};}
const key={enabled:true,apiKey:'test-private-key',monthlyBudgetYuan:20};

test('canonical audio accepts two minutes and rejects spoofed headers, silence and oversized clips',()=>{
  assert.equal(inspectVoiceWav(audio(120)).seconds,120);
  for(const offset of [4,16,20,22,24,28,32,34,40]){const data=audio(1);data[offset]^=1;assert.throws(()=>inspectVoiceWav(data),/格式/);}
  assert.throws(()=>inspectVoiceWav(encodeVoiceWav(new Float32Array(16000))),/没有录到声音/);
  assert.throws(()=>inspectVoiceWav(audio(0.25)),/长度/);
  assert.throws(()=>encodeVoiceWav(new Float32Array(16000*121)),/长度/);
});

test('voice sends only the current audio to the fixed provider; repeats and account isolation do not leak text',async t=>{
  const {store,user,other}=setup(t),calls=[],payload=input();let release;
  const voice=createVoice({store,config:key,fetchOverride:async(url,options)=>{calls.push({url,options});await new Promise(resolve=>release=resolve);return answer('明天上午九点开会');}});
  const first=voice.transcribe(user,payload);await Promise.resolve();
  assert.equal((await voice.transcribe(user,payload)).state,'processing');assert.equal(calls.length,1);
  assert.throws(()=>voice.result(other,payload.id),e=>e.status===404);
  release();assert.equal((await first).text,'明天上午九点开会');assert.equal((await voice.transcribe(user,payload)).text,'明天上午九点开会');assert.equal(calls.length,1);
  const sent=JSON.parse(calls[0].options.body);assert.equal(calls[0].url,'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');assert.equal(calls[0].options.redirect,'error');assert.equal(sent.model,'qwen3-asr-flash');assert.equal(sent.messages.length,1);assert.ok(sent.messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,'));
  assert.deepEqual(store.forUser(user).list(),[]);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM voice_usage').get().n,1);
  assert.ok(!JSON.stringify(voice.status(user)).includes(key.apiKey));
  await assert.rejects(()=>voice.transcribe(user,{...payload,audio:audio(2).toString('base64')}),e=>e.status===409);
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM voice_jobs').all()).includes(payload.audio));
});

test('consent and configuration are mandatory; provider errors are sanitized and never blindly retried',async t=>{
  const {store,user}=setup(t);let calls=0;const voice=createVoice({store,config:key,fetchOverride:async()=>{calls++;throw new Error('secret '+key.apiKey);}}),payload=input();
  await assert.rejects(()=>voice.transcribe(user,{...payload,consent:false}));assert.equal(calls,0);
  const failed=await voice.transcribe(user,payload);assert.equal(failed.state,'failed');assert.ok(!failed.error.includes(key.apiKey));assert.equal((await voice.transcribe(user,payload)).state,'failed');assert.equal(calls,1);
  await assert.rejects(()=>createVoice({store,config:null}).transcribe(user,input()),e=>e.status===503);
});

test('voice and text share the monthly budget, while voice has a duration cap per account',async t=>{
  const {store,user,other}=setup(t);let calls=0;
  const voice=createVoice({store,config:{...key,voiceDailySeconds:2},fetchOverride:async()=>{calls++;return answer('语音文字');}});
  await voice.transcribe(user,input(2));await assert.rejects(()=>voice.transcribe(user,input(1)),e=>e.status===429);assert.equal(calls,1);
  await voice.transcribe(other,input(1));assert.equal(calls,2);
  const ai=createAi({store,config:{...key,monthlyBudgetYuan:0.0007},fetchOverride:async()=>{throw new Error('Must not call');}});
  const e=entrySchema.parse({id:randomUUID(),kind:'note',body:'预算不足时保存原文',captureMode:'auto'}),saved=store.forUser(user).mutate({operationId:randomUUID(),baseVersion:0,entry:e},'test').entry;
  ai.enqueue(user,saved);await ai.tick();assert.equal(ai.status(user).jobs[0].state,'failed');assert.match(ai.status(user).jobs[0].error,/额度/);
  const limited=createVoice({store,config:{...key,monthlyBudgetYuan:0.0007},fetchOverride:async()=>answer('不应发送')});await assert.rejects(()=>limited.transcribe(user,input()),e=>e.status===429);
});

test('temporary text expires and interrupted jobs can be recovered without another call',async t=>{
  const {store,user}=setup(t);let stamp=Date.now(),calls=0;const voice=createVoice({store,config:key,now:()=>stamp,fetchOverride:async()=>{calls++;return answer('临时转写内容');}}),payload=input();
  await voice.transcribe(user,payload);stamp+=600001;voice.cleanup();assert.equal(voice.result(user,payload.id).state,'expired');assert.equal(store.db.prepare('SELECT transcript FROM voice_jobs').get().transcript,null);
  assert.equal((await voice.transcribe(user,payload)).state,'expired');assert.equal(calls,1);
  store.db.prepare("UPDATE voice_jobs SET state='processing',updated_at=?").run(stamp-90001);voice.cleanup();assert.equal(voice.result(user,payload.id).state,'failed');
});

test('maximum audio reaches provider without regex failure; invalid or incomplete transcripts stay out of drafts',async t=>{
  const {store,user}=setup(t);for(const response of [answer(''),answer('x'.repeat(8001)),{ok:false,status:401},{ok:true,text:async()=>'{bad json'}]){
    const voice=createVoice({store,config:key,fetchOverride:async()=>response});assert.equal((await voice.transcribe(user,input(120))).state,'failed');
  }
  assert.equal(store.forUser(user).list().length,0);
});

test('microphone granted after cancellation is released without beginning recording',async()=>{
  const controller=new AbortController();let grant,stopped=0;
  const env={isSecureContext:true,OfflineAudioContext:class{},MediaRecorder:class{},navigator:{mediaDevices:{getUserMedia:()=>new Promise(resolve=>grant=resolve)}}};
  const pending=startMicrophone({signal:controller.signal,env});controller.abort();grant({getTracks:()=>[{stop:()=>stopped++}]});await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(stopped,1);
});

test('stopping recording releases the microphone and cancellation discards its data',async()=>{
  for(const cancelled of [false,true]){
    const controller=new AbortController();let stopped=0,releasedBeforeData=false,dataSeen=false;
    class Recorder{static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{dataSeen=true;this.ondataavailable({data:new Blob(['audio'])});this.onstop();});}}
    const env={isSecureContext:true,OfflineAudioContext:class{},MediaRecorder:Recorder,navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>{stopped++;if(!dataSeen)releasedBeforeData=true;},addEventListener(){}}]})}}};
    const capture=await startMicrophone({signal:controller.signal,env});if(cancelled){controller.abort();await assert.rejects(capture.done,e=>e.name==='AbortError');}else{capture.stop();assert.equal((await capture.done).size,5);}assert.ok(stopped>=1);
    if(!cancelled)assert.equal(releasedBeforeData,false);
  }
});

test('lost response recovery fetches the existing result and append preserves typed drafts',async()=>{
  const clip={id:randomUUID(),bytes:audio(1),submitted:true},calls=[];
  const text=await requestTranscript(async(url,options)=>{calls.push(options);assert.match(url,/\/api\/voice\/jobs\//);return {state:'done',text:'语音内容'};},clip,{signal:new AbortController().signal,retry:true});
  assert.equal(calls.length,1);assert.equal(appendTranscript('已输入的文字',text),'已输入的文字\n语音内容');assert.equal(appendTranscript('',text),text);
});

test('voice routes enforce login, account binding, CSRF and a microphone policy restricted to this site',async t=>{
  const {store,config}=setup(t),mails=[];let calls=0;
  const {app}=createApp({store,accountConfig:config,aiConfig:key,secureCookies:false,origin:'http://127.0.0.1',sendMailOverride:async m=>mails.push(m),voiceFetchOverride:async()=>{calls++;return answer('测试转写');}});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
  const post=(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1',...headers},body:JSON.stringify(body)});
  const anonymous=await post('/api/voice/transcribe',input());assert.equal(anonymous.status,401);assert.match(anonymous.headers.get('permissions-policy'),/microphone=\(self\)/);
  await post('/api/auth/email-code',{email:config.ownerEmail,purpose:'register'});const register=await post('/api/auth/register',{email:config.ownerEmail,password:'Synthetic long password 123!',code:mails.at(-1).code}),account=await register.json(),cookie=register.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/voice/transcribe',input(),{Cookie:cookie})).status,403);
  assert.equal((await post('/api/voice/transcribe',input(),{Cookie:cookie,'X-Me-CSRF':account.csrf,'X-Me-Account':randomUUID()})).status,409);
  const valid=await post('/api/voice/transcribe',input(),{Cookie:cookie,'X-Me-CSRF':account.csrf,'X-Me-Account':account.user.id});assert.equal(valid.status,200);assert.equal((await valid.json()).text,'测试转写');assert.equal(calls,1);
});
