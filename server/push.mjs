import webpush from 'web-push';
import { readFileSync } from 'node:fs';

export function validPushEndpoint(endpoint){
  try{const url=new URL(endpoint),h=url.hostname;return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&(h==='fcm.googleapis.com'||h==='updates.push.services.mozilla.com'||h==='push.services.mozilla.com'||h.endsWith('.push.apple.com')||h.endsWith('.notify.windows.com'));}catch{return false;}
}
export function createPush({store,vapidFile,sendOverride,now=()=>Date.now()}){
  let keys;
  try{keys=JSON.parse(readFileSync(vapidFile,'utf8'));webpush.setVapidDetails('https://me.joybeat.cn',keys.publicKey,keys.privateKey);}catch{keys=null;}
  const send=sendOverride??((sub,payload)=>webpush.sendNotification(sub,JSON.stringify(payload),{TTL:3600,urgency:'normal',timeout:12000}));
  let running=false;
  async function tick(){
    if(running||(!keys&&!sendOverride))return;running=true;
    try{
      const stamp=now(),entries=store.list().filter(e=>!e.deletedAt&&e.status==='active'&&e.reminderAt&&Date.parse(e.reminderAt)<=stamp&&Date.parse(e.reminderAt)>stamp-86400000);
      const subscriptions=store.db.prepare('SELECT s.*,d.user_id FROM subscriptions s JOIN devices d ON s.device_id=d.id WHERE d.active=1 AND d.expires_at>?').all(new Date(stamp).toISOString());
      for(const entry of entries)for(const sub of subscriptions){
        const owner=store.db.prepare('SELECT user_id FROM entries WHERE id=?').get(entry.id)?.user_id;if(owner!==sub.user_id)continue;
        store.db.prepare("INSERT OR IGNORE INTO deliveries(entry_id,reminder_at,endpoint,state) VALUES (?,?,?,'pending')").run(entry.id,entry.reminderAt,sub.endpoint);
        const claim=store.db.prepare("UPDATE deliveries SET state='retry',attempts=attempts+1,next_attempt=? WHERE entry_id=? AND reminder_at=? AND endpoint=? AND state IN ('pending','retry') AND attempts<5 AND next_attempt<=?").run(stamp+60000,entry.id,entry.reminderAt,sub.endpoint,stamp);
        if(!claim.changes)continue;
        const current=store.get(entry.id),device=store.db.prepare('SELECT active FROM devices WHERE id=?').get(sub.device_id);
        if(!current||current.deletedAt||current.status!=='active'||current.reminderAt!==entry.reminderAt||!device?.active){store.db.prepare("UPDATE deliveries SET state='cancelled' WHERE entry_id=? AND reminder_at=? AND endpoint=?").run(entry.id,entry.reminderAt,sub.endpoint);continue;}
        try{
          await send(JSON.parse(sub.content),{title:entry.title||entry.body.split('\n')[0].slice(0,50),body:'你安排的事项到时间了，点开查看。',url:`/?entry=${entry.id}`,tag:`me-${entry.id}-${entry.reminderAt}`});
          store.db.prepare("UPDATE deliveries SET state='sent',last_error=NULL WHERE entry_id=? AND reminder_at=? AND endpoint=?").run(entry.id,entry.reminderAt,sub.endpoint);
        }catch(error){
          const permanent=[404,410].includes(error.statusCode);
          if(permanent)store.db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(sub.endpoint);
          store.db.prepare('UPDATE deliveries SET state=?,last_error=?,next_attempt=? WHERE entry_id=? AND reminder_at=? AND endpoint=?').run(permanent?'expired':'retry',String(error.statusCode??'network'),stamp+300000,entry.id,entry.reminderAt,sub.endpoint);
        }
      }
    }finally{running=false;}
  }
  async function test(deviceId){
    if(!keys&&!sendOverride)throw new Error('推送服务尚未配置');
    const rows=store.db.prepare('SELECT content FROM subscriptions WHERE device_id=?').all(deviceId);
    if(!rows.length)throw new Error('请先在本机开启通知');
    await Promise.all(rows.map(r=>send(JSON.parse(r.content),{title:'Me · 提醒已连接',body:'这是一次测试通知。锁屏后也试一次，确认这台设备可以收到。',url:'/',tag:'me-test'})));
  }
  return {tick,test,publicKey:keys?.publicKey??null};
}
