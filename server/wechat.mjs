import {randomBytes,randomUUID,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createWechat({store,secret,origin='https://me.joybeat.cn',enabled=false,fetchOverride=fetch,now=()=>Date.now()}){
  const db=store.db,key=createHash('sha256').update(`wechat:${secret}`).digest();let running=false;
  function encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv.toString('base64url'),body.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');}
  function decrypt(value){const [iv,body,tag]=value.split('.').map(v=>Buffer.from(v,'base64url'));const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(body),decipher.final()]).toString('utf8');}
  function binding(userId){return db.prepare('SELECT * FROM wechat_bindings WHERE user_id=? AND enabled=1').get(userId);}
  function status(userId){return {available:enabled,provider:'pushplus',connected:Boolean(binding(userId)),deliveries:db.prepare('SELECT d.id,d.entry_id AS entryId,d.state,d.mode,d.last_error AS error,d.created_at AS createdAt,d.updated_at AS updatedAt,a.action AS response,a.created_at AS respondedAt,a.snooze_until AS snoozeUntil FROM wechat_deliveries d LEFT JOIN reminder_actions a ON a.delivery_id=d.id WHERE d.user_id=? ORDER BY d.created_at DESC LIMIT 15').all(userId)};}
  function bind(userId,token){if(!enabled)throw Object.assign(new Error('微信提醒尚未启用'),{status:503});const value=encrypt(token);db.prepare('INSERT INTO wechat_bindings VALUES (?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET encrypted_token=excluded.encrypted_token,enabled=1,created_at=excluded.created_at').run(userId,value,new Date(now()).toISOString());}
  function unbind(userId){db.prepare('DELETE FROM wechat_bindings WHERE user_id=?').run(userId);db.prepare("UPDATE wechat_deliveries SET state='cancelled',updated_at=? WHERE user_id=? AND state IN ('pending','retry')").run(new Date(now()).toISOString(),userId);}
  function content(entry,job){const body=entry.body.slice(0,2000),url=`${origin}/?entry=${encodeURIComponent(entry.id)}&reminder=${encodeURIComponent(job.id)}`;return `<p>${escape(body).replace(/\n/g,'<br>')}</p>${entry.body.length>2000?'<p>内容较长，完整记录请回网站查看。</p>':''}<p><a href="${escape(url)}">查看并处理：已知晓 / 已完成 / 稍后提醒</a></p>`;}
  async function deliver(job){
    const linked=binding(job.user_id),entry=job.entry_id?store.forUser(job.user_id).get(job.entry_id):null;
    const invalid=!linked||(job.entry_id&&(!entry||entry.deletedAt))||(job.mode==='scheduled'&&(entry.status!=='active'||!entry.wechatReminder||entry.reminderAt!==job.reminder_at||Date.parse(job.reminder_at)<=now()-86400000));
    if(invalid){db.prepare("UPDATE wechat_deliveries SET state='cancelled',updated_at=? WHERE id=?").run(new Date(now()).toISOString(),job.id);return;}
    const claimed=db.prepare("UPDATE wechat_deliveries SET state='sending',attempts=attempts+1,updated_at=? WHERE id=? AND state IN ('pending','retry')").run(new Date(now()).toISOString(),job.id);if(!claimed.changes)return;
    const callback=randomBytes(32).toString('base64url');db.prepare('UPDATE wechat_deliveries SET callback_hash=? WHERE id=?').run(sha(callback),job.id);
    try{
      const response=await fetchOverride('https://www.pushplus.plus/send',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({token:decrypt(linked.encrypted_token),channel:'wechat',template:'html',title:entry?(entry.title||entry.body.split('\n')[0]).slice(0,80):'Me · 微信提醒测试',content:entry?content(entry,job):'<p>微信提醒连接测试。请确认这条消息出现在你的微信中。</p>',timestamp:now()+3600000,callbackUrl:`${origin}/api/wechat/callback/${callback}`})});
      const result=await response.json();
      if(!response.ok||result.code!==200){const limited=response.status===429&&!([900,905,903,888].includes(result.code));if([900,905,903,888].includes(result.code)){db.prepare('UPDATE wechat_bindings SET enabled=0 WHERE user_id=?').run(job.user_id);db.prepare("UPDATE wechat_deliveries SET state='cancelled' WHERE user_id=? AND state IN ('pending','retry')").run(job.user_id);}db.prepare('UPDATE wechat_deliveries SET state=?,next_attempt=?,last_error=?,updated_at=? WHERE id=?').run(limited&&job.attempts<3?'retry':'failed',now()+5*60000,({900:'PushPlus 账号受限，已暂停连接，请到平台解除限制后重新连接',905:'PushPlus 要求完成实名认证，完成后请重新连接',903:'通知令牌无效，请重新连接',888:'PushPlus 额度不足，已暂停连接，请检查平台额度'}[result.code]??`通知服务拒绝请求（${Number(result.code)||response.status}）`),new Date(now()).toISOString(),job.id);return;}
      if(typeof result.data!=='string'||!result.data||result.data.length>200)throw new Error('Unrecognized provider response');
      db.prepare("UPDATE wechat_deliveries SET state='queued',short_code=?,last_error=NULL,updated_at=? WHERE id=? AND state='sending'").run(result.data,new Date(now()).toISOString(),job.id);
    }catch{
      // A timeout may happen after the provider accepted a request. Do not blindly resend.
      db.prepare("UPDATE wechat_deliveries SET state='unknown',last_error='未能确认通知服务是否收到，请先检查微信，避免重复发送',updated_at=? WHERE id=? AND state='sending'").run(new Date(now()).toISOString(),job.id);
    }
  }
  async function sendNow(userId,entryId=null){if(!enabled||!binding(userId))throw Object.assign(new Error('请先连接微信提醒'),{status:400});if(entryId&&!store.forUser(userId).get(entryId))throw Object.assign(new Error('记录不存在'),{status:404});const id=randomUUID(),stamp=new Date(now()).toISOString();db.prepare('INSERT INTO wechat_deliveries(id,user_id,entry_id,mode,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,userId,entryId,entryId?'manual':'test','pending',stamp,stamp);await deliver(db.prepare('SELECT * FROM wechat_deliveries WHERE id=?').get(id));return db.prepare('SELECT id,state,last_error AS error FROM wechat_deliveries WHERE id=?').get(id);}
  function callback(token,body){
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))return false;
    const job=db.prepare('SELECT id,short_code,state FROM wechat_deliveries WHERE callback_hash=?').get(sha(token)),shortCode=body?.messageInfo?.shortCode;
    if(!job||typeof shortCode!=='string'||!shortCode||shortCode.length>200||(job.short_code&&job.short_code!==shortCode)||body.event!=='message_complate'||!['sending','queued','unknown'].includes(job.state))return false;
    const code=body.messageInfo.sendStatus;if(![2,3].includes(code))return false;
    db.prepare('UPDATE wechat_deliveries SET state=?,short_code=?,last_error=?,updated_at=? WHERE id=?').run(code===2?'delivered':'failed',shortCode,code===2?null:'通知平台报告投递失败，请检查微信连接和平台额度',new Date(now()).toISOString(),job.id);return true;
  }
  async function tick(){if(!enabled||running)return;running=true;try{
    const stamp=now();db.prepare("UPDATE wechat_deliveries SET state='unknown',last_error='平台暂未返回回执，投递结果未确认',updated_at=? WHERE state='queued' AND updated_at<?").run(new Date(stamp).toISOString(),new Date(stamp-300000).toISOString());db.prepare("UPDATE wechat_deliveries SET state='unknown',last_error='发送过程被中断，请先检查微信',updated_at=? WHERE state='sending' AND updated_at<?").run(new Date(stamp).toISOString(),new Date(stamp-120000).toISOString());
    const rows=db.prepare('SELECT e.id,e.user_id,e.content FROM entries e JOIN wechat_bindings b ON b.user_id=e.user_id WHERE b.enabled=1').all();
    for(const row of rows){const e=JSON.parse(row.content);if(e.deletedAt||e.status!=='active'||!e.wechatReminder||!e.reminderAt||Date.parse(e.reminderAt)>stamp||Date.parse(e.reminderAt)<=stamp-86400000)continue;db.prepare("INSERT OR IGNORE INTO wechat_deliveries(id,user_id,entry_id,reminder_at,mode,state,created_at,updated_at) VALUES (?,?,?,?,'scheduled','pending',?,?)").run(randomUUID(),row.user_id,row.id,e.reminderAt,new Date(stamp).toISOString(),new Date(stamp).toISOString());}
    const jobs=db.prepare("SELECT * FROM wechat_deliveries WHERE state IN ('pending','retry') AND next_attempt<=? ORDER BY created_at LIMIT 20").all(stamp);for(const job of jobs)await deliver(job);
  }finally{running=false;}}
  function receipt(userId,deliveryId){
    const job=db.prepare('SELECT id,entry_id AS entryId,state,last_error AS error,created_at AS createdAt,reminder_at AS reminderAt,mode FROM wechat_deliveries WHERE id=? AND user_id=?').get(deliveryId,userId);
    if(!job)throw Object.assign(new Error('提醒不存在或不属于当前账号'),{status:404});
    const entry=job.entryId?store.forUser(userId).get(job.entryId):null;
    if(!entry||entry.deletedAt)throw Object.assign(new Error('这条记录已移入回收站或不存在'),{status:404});
    return {delivery:job,entry,response:db.prepare('SELECT action,snooze_until AS snoozeUntil,created_at AS respondedAt FROM reminder_actions WHERE delivery_id=? AND user_id=?').get(deliveryId,userId)??null};
  }
  function respond(userId,deliveryId,{action,version,minutes=15}){
    return store.transaction(()=>{
      const {delivery,entry,response}=receipt(userId,deliveryId);
      if(response?.action===action||response?.action==='done'||(response?.action==='snoozed'&&action!=='acknowledged'))return {ok:true,...receipt(userId,deliveryId)};
      if(!['acknowledged','done','snoozed'].includes(action))throw Object.assign(new Error('操作无效'),{status:400});
      const scope=store.forUser(userId);let snoozeUntil=null;
      if(action!=='acknowledged'){
        if(entry.version!==version)throw Object.assign(new Error('记录已更新，请重新打开提醒后处理'),{status:409});
        if(entry.status!=='active')throw Object.assign(new Error('此记录已完成、取消或归档'),{status:409});
        if(delivery.mode==='scheduled'&&delivery.reminderAt!==entry.reminderAt)throw Object.assign(new Error('提醒时间已调整，请从最新记录处理'),{status:409});
        if(action==='done'&&entry.kind!=='task')throw Object.assign(new Error('只有待办可以标记完成，其他记录请使用已知晓'),{status:400});
        if(action==='snoozed'){
          if(![15,30,60].includes(minutes))throw Object.assign(new Error('延后时间无效'),{status:400});
          if(!binding(userId))throw Object.assign(new Error('请先重新连接微信提醒'),{status:400});
          snoozeUntil=new Date(now()+minutes*60000).toISOString();
        }
        const {version:oldVersion,createdAt,updatedAt,pending,...data}=entry;
        const changed=scope.mutate({operationId:randomUUID(),baseVersion:oldVersion,entry:{...data,...(action==='done'?{status:'done',inbox:false}:{reminderAt:snoozeUntil,wechatReminder:true})}},'reminder:'+deliveryId);
        if(changed.status!==200)throw Object.assign(new Error('记录已更新，请重新打开'),{status:409});
      }
      if(!(response?.action==='snoozed'&&action==='acknowledged'))db.prepare('INSERT INTO reminder_actions VALUES (?,?,?,?,?) ON CONFLICT(delivery_id) DO UPDATE SET action=excluded.action,snooze_until=excluded.snooze_until,created_at=excluded.created_at').run(deliveryId,userId,action,snoozeUntil,new Date(now()).toISOString());
      store.audit('reminder:'+deliveryId,'reminder.'+action);return {ok:true,...receipt(userId,deliveryId)};
    });
  }
  async function submitOrganization(userId,payload){const linked=binding(userId);if(!enabled||!linked)throw Object.assign(new Error('微信未连接'),{status:400});const response=await fetchOverride('https://www.pushplus.plus/send',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,token:decrypt(linked.encrypted_token),channel:'wechat',template:'html'})});const result=await response.json();if(!response.ok||result.code!==200)throw Object.assign(new Error('通知平台未受理'),{status:502});return result.data;}
  return {submitOrganization,status,bind,unbind,sendNow,callback,tick,receipt,respond,connected:userId=>Boolean(binding(userId))};
}
