import express from 'express';
import {createOrganizations} from './organizations.mjs';
import {createOrganizationAi} from './organization-ai.mjs';
import {createOrganizationNotifications} from './organization-notifications.mjs';
import {organizationRouter} from './organization-router.mjs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {z} from 'zod';
import {createAuth} from './auth.mjs';
import {createAccountAuth} from './account-auth.mjs';
import {createPush,validPushEndpoint} from './push.mjs';
import {createWechat} from './wechat.mjs';
import {createAi} from './ai.mjs';
import {createVoice} from './voice.mjs';
import {mutationSchema,importSchema,subscriptionSchema} from './schema.mjs';

export function createApp({store,mode='account',origin='https://me.joybeat.cn',accountConfig,aiConfig,aiFetchOverride,voiceFetchOverride,secureCookies=true,sendMailOverride,wechatFetchOverride,proxySecret,caFile,vapidFile,dist=path.resolve('dist')}){
  const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
  const accounts=mode==='account';
  const auth=accounts?createAccountAuth({store,config:accountConfig,origin,secure:secureCookies,sendMailOverride}):createAuth({store,mode,caFile,proxySecret,csrfSecret:randomBytes(32),origin});
  const push=createPush({store,vapidFile}),wechat=createWechat({store,secret:accountConfig?.secret??'disabled',origin,enabled:accounts&&accountConfig?.wechatProvider==='pushplus',fetchOverride:wechatFetchOverride});
  const ai=createAi({store,config:accounts?aiConfig:null,fetchOverride:aiFetchOverride});
  const voice=createVoice({store,config:accounts?aiConfig:null,fetchOverride:voiceFetchOverride});
  const org=accounts?createOrganizations({store,secret:accountConfig.secret,origin}):null,orgAi=accounts?createOrganizationAi({store,org,config:aiConfig,fetchOverride:aiFetchOverride}):null,orgNotifications=accounts?createOrganizationNotifications({org,wechat,origin}):null;
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow, noarchive','Permissions-Policy':'camera=(), microphone=(self), geolocation=()','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"});
    if(secureCookies&&mode!=='local-dev')res.set('Strict-Transport-Security','max-age=31536000');next();
  });
  app.get('/healthz',(_req,res)=>res.json({ok:true}));
  if(accounts){app.post('/api/organization-notifications/callback/:token',express.json({limit:'8kb'}),(req,res)=>{const ok=orgNotifications.callback(req.params.token,req.body);res.status(ok?200:404).json({ok});});app.post('/api/wechat/callback/:token',express.json({limit:'8kb'}),(req,res)=>{const ok=wechat.callback(req.params.token,req.body);res.status(ok?200:404).json({ok});});app.use('/api/auth',auth.router);}
  app.use(accounts?'/api':'/',auth.authenticate);
  const limits=new Map();
  app.use('/api',(req,res,next)=>{
    if(accounts&&req.get('x-me-account')&&req.get('x-me-account')!==req.user.id)return res.status(409).json({code:'ACCOUNT_CHANGED',error:'账号已切换，请刷新页面'});
    req.workspace=accounts?store.forUser(req.user.id):store;
    const now=Date.now(),key=req.device.id,old=limits.get(key),limit=old&&old.until>now?old:{until:now+60000,count:0};limit.count++;limits.set(key,limit);
    if(limits.size>1000)for(const [id,value] of limits)if(value.until<now)limits.delete(id);
    if(limit.count>300){res.set('Retry-After','60');return res.status(429).json({error:'操作太频繁，请稍后重试'});}next();
  });
  app.use('/api',auth.protectMutation);
  let voiceUploads=0;
  if(accounts)app.post(['/api/voice/transcribe','/api/organizations/:orgId/voice/transcribe'],(req,res,next)=>{if(req.params.orgId)orgAi.voiceContext(org.context(req.user.id,req.params.orgId));auth.limit(`voice-request:${req.user.id}`,12,60000);if(voiceUploads>=2)return res.status(429).json({error:'语音服务正忙，请稍后重试'});voiceUploads++;let released=false;const release=()=>{if(!released){released=true;voiceUploads--;}};res.once('finish',release);res.once('close',release);next();},express.json({limit:'6mb'}));
  app.use('/api',express.json({limit:'10mb'}));
  if(accounts)app.use('/api/organizations',organizationRouter({org,auth,orgAi,voice,orgNotifications}));
  app.get('/api/bootstrap',(req,res)=>res.json({...(accounts?{user:auth.userView(req.user)}:{}),device:{id:req.device.id,name:req.device.name,expiresAt:req.device.expires_at},csrf:accounts?auth.csrf(req):auth.csrf(req.device.id),pushPublicKey:push.publicKey,wechat:accounts?{available:accountConfig.wechatProvider==='pushplus',connected:wechat.connected(req.user.id)}:null,mailConfigured:accounts?auth.mailConfigured:false,serverExpiresAt:'2027-06-16T00:18:22+08:00',timezone:'Asia/Shanghai'}));
  app.get('/api/entries',(req,res)=>res.json({entries:req.workspace.list(),serverTime:new Date().toISOString()}));
  app.post('/api/mutations',(req,res)=>{const input=mutationSchema.parse(req.body),result=req.workspace.mutate(input,req.device.id);if(accounts&&result.status===200&&input.baseVersion===0&&input.entry.captureMode)ai.enqueue(req.user.id,result.entry,input.entry.captureMode);res.status(result.status).json(result);});
  app.get('/api/export',(req,res)=>{if(accounts&&req.query.account!==req.user.id)return res.status(403).json({error:'账号已切换，请重新打开导出页面'});store.audit(req.device.id,'backup.export');res.attachment(`me-backup-${new Date().toISOString().slice(0,10)}.json`).json(req.workspace.exportData());});
  app.post('/api/import',(req,res)=>{const data=importSchema.parse(req.body);try{res.json(req.workspace.importEntries(data.entries,req.device.id));}catch{res.status(400).json({error:'备份数据存在无效或重复关联，未导入任何内容'});}});
  app.get('/api/devices',(req,res)=>{const devices=accounts?store.db.prepare("SELECT id,name,active,created_at AS createdAt,last_seen AS lastSeen,expires_at AS expiresAt FROM devices WHERE user_id=? AND fingerprint LIKE 'session:%' ORDER BY created_at DESC").all(req.user.id):store.db.prepare('SELECT id,name,active,created_at AS createdAt,last_seen AS lastSeen,expires_at AS expiresAt FROM devices ORDER BY created_at').all();res.json({devices:devices.map(d=>({...d,current:d.id===req.device.id,notifications:Boolean(store.db.prepare('SELECT 1 FROM subscriptions WHERE device_id=?').get(d.id))}))});});
  app.patch('/api/devices/:id',(req,res)=>{
    const data=z.object({name:z.string().trim().min(1).max(60).optional(),revoke:z.literal(true).optional()}).strict().parse(req.body);
    if(data.revoke&&req.params.id===req.device.id)return res.status(400).json({error:'请使用退出登录结束本机登录'});
    const found=accounts?store.db.prepare('SELECT id FROM devices WHERE id=? AND user_id=?').get(req.params.id,req.user.id):store.db.prepare('SELECT id FROM devices WHERE id=?').get(req.params.id);if(!found)return res.status(404).json({error:'设备不存在'});
    if(data.name)store.db.prepare('UPDATE devices SET name=? WHERE id=?').run(data.name,found.id);
    if(data.revoke){store.db.prepare('UPDATE devices SET active=0 WHERE id=?').run(found.id);store.db.prepare('DELETE FROM sessions WHERE device_id=?').run(found.id);store.db.prepare('DELETE FROM subscriptions WHERE device_id=?').run(found.id);}
    store.audit(req.device.id,data.revoke?'session.revoke':'device.rename');res.json({ok:true});
  });
  app.get('/api/push/status',(req,res)=>res.json({enabled:Boolean(store.db.prepare('SELECT 1 FROM subscriptions WHERE device_id=?').get(req.device.id)),configured:Boolean(push.publicKey)}));
  app.post('/api/push/subscribe',(req,res)=>{
    if(!push.publicKey)return res.status(503).json({error:'提醒服务尚未配置'});
    const sub=subscriptionSchema.parse(req.body);if(!validPushEndpoint(sub.endpoint))return res.status(400).json({error:'当前浏览器的推送服务暂不支持'});
    const prior=store.db.prepare('SELECT s.device_id,d.user_id FROM subscriptions s JOIN devices d ON d.id=s.device_id WHERE s.endpoint=?').get(sub.endpoint);
    if(prior&&prior.device_id!==req.device.id&&(!accounts||prior.user_id!==req.user.id))return res.status(409).json({error:'此通知订阅已属于另一账号，请先退出旧账号的浏览器通知'});
    store.db.prepare('INSERT INTO subscriptions VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET content=excluded.content,device_id=excluded.device_id').run(sub.endpoint,req.device.id,JSON.stringify(sub),new Date().toISOString());res.json({ok:true});
  });
  app.post('/api/push/unsubscribe',(req,res)=>{store.db.prepare('DELETE FROM subscriptions WHERE device_id=?').run(req.device.id);res.json({ok:true});});
  app.post('/api/push/test',async(req,res)=>{try{await push.test(req.device.id);res.json({ok:true,message:'已提交推送，请确认手机实际收到'});}catch{res.status(502).json({error:'测试推送未成功，请检查本机订阅和网络'});}});
  if(accounts){
    app.get('/api/voice',(req,res)=>res.json(voice.status(req.user.id)));
    app.get('/api/voice/jobs/:id',(req,res)=>res.json(voice.result(req.user.id,req.params.id)));
    app.post('/api/voice/transcribe',async(req,res)=>{const result=await voice.transcribe(req.user.id,req.body);res.status(result.state==='processing'?202:200).json(result);});
    app.get('/api/ai',(req,res)=>res.json(ai.status(req.user.id)));
    app.patch('/api/ai/preferences',(req,res)=>{const data=z.object({enabled:z.boolean().optional(),wechatAuto:z.boolean().optional(),consent:z.literal(true).optional()}).strict().parse(req.body);if(data.enabled===true&&!data.consent)return res.status(400).json({error:'启用前请同意将所记录内容发送给阿里云百炼整理'});res.json(ai.setPreference(req.user.id,data));});
    app.get('/api/ai/entries/:id',(req,res)=>res.json({job:ai.detail(req.user.id,req.params.id)}));
    app.post('/api/ai/entries/:id/analyze',(req,res)=>{auth.limit(`ai-request:${req.user.id}`,10,60000);const data=z.object({version:z.number().int().positive(),kind:z.enum(['auto','note','task','event'])}).strict().parse(req.body);const entry=req.workspace.get(req.params.id);if(!entry)return res.status(404).json({error:'记录不存在'});if(entry.version!==data.version)return res.status(409).json({error:'记录已更新，请重新打开后整理'});res.status(202).json(ai.enqueue(req.user.id,entry,data.kind,true));});
    app.post('/api/ai/jobs/:id/undo',(req,res)=>res.json(ai.undo(req.user.id,req.params.id)));
    app.get('/api/reminders/:id',(req,res)=>res.json(wechat.receipt(req.user.id,req.params.id)));
    app.post('/api/reminders/:id/action',(req,res)=>{const data=z.object({action:z.enum(['acknowledged','done','snoozed']),version:z.number().int().positive(),minutes:z.union([z.literal(15),z.literal(30),z.literal(60)]).optional()}).strict().parse(req.body);res.json(wechat.respond(req.user.id,req.params.id,data));});
    app.get('/api/wechat',(req,res)=>res.json(wechat.status(req.user.id)));
    app.post('/api/wechat/binding',(req,res)=>{const {token}=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{16,128}$/,'通知令牌格式不正确'),consent:z.literal(true)}).strict().parse(req.body);wechat.bind(req.user.id,token);store.audit(req.device.id,'wechat.bind');res.json({ok:true});});
    app.delete('/api/wechat/binding',(req,res)=>{wechat.unbind(req.user.id);res.json({ok:true});});
    app.post('/api/wechat/send',async(req,res)=>{auth.limit(`wechat-send:${req.user.id}`,10,60000);const {entryId,version}=z.object({entryId:z.uuid().optional(),version:z.number().int().positive().optional()}).strict().parse(req.body);if(entryId&&version!==undefined&&req.workspace.get(entryId)?.version!==version)return res.status(409).json({error:'记录已有更新，请重新打开后再推送'});const result=await wechat.sendNow(req.user.id,entryId);res.status(['failed','unknown'].includes(result.state)?502:result.state==='cancelled'?409:202).json({...result,...(result.state==='cancelled'?{error:'这条记录已被删除或提醒已取消'}:{}),message:result.state==='delivered'?'通知平台已报告投递成功':result.state==='retry'?'通知服务繁忙，服务器会稍后重试':'已提交给通知服务，请在微信中确认收到'});});
  }
  app.get('/api/system',(req,res)=>{const backup=store.db.prepare("SELECT value FROM meta WHERE key='lastBackup'").get();res.json({version:'3.1.0',lastBackup:backup?JSON.parse(backup.value):null,entryCount:req.workspace.list().length,serverExpiresAt:'2027-06-16T00:18:22+08:00'});});
  app.use('/api',(_req,res)=>res.status(404).json({error:'接口不存在'}));
  app.get('/sw.js',(_req,res)=>{res.set('Service-Worker-Allowed','/');res.type('js').send(readFileSync(path.join(dist,'sw.js')));});
  app.use(express.static(dist,{index:false,etag:false,cacheControl:false}));
  app.get('/{*path}',(_req,res)=>{if(existsSync(path.join(dist,'index.html')))res.sendFile(path.join(dist,'index.html'));else res.status(503).send('应用正在准备中');});
  app.use((error,_req,res,_next)=>{
    if(error instanceof z.ZodError)return res.status(400).json({error:error.issues[0]?.message??'输入内容无效'});
    if(error.type==='entity.too.large')return res.status(413).json({error:'文件过大'});
    if(error instanceof SyntaxError&&'body' in error)return res.status(400).json({error:'数据格式无效'});
    if(error.status&&[400,403,404,409,429,502,503].includes(error.status))return res.status(error.status).json({error:error.message});
    console.error('Request failed:',error.code??error.name);res.status(500).json({error:'暂时无法完成操作，请稍后重试'});
  });
  return {app,push,wechat,auth,ai,voice,org,orgAi,orgNotifications};
}
