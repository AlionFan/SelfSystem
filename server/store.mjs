import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {migrateAccounts} from './account-schema.mjs';
import {mutationSchema} from './schema.mjs';
import {migrateOrganizations} from './organization-schema.mjs';

export function openStore(directory){
  mkdirSync(directory,{recursive:true,mode:0o700});
  const db=new DatabaseSync(path.join(directory,'me.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,fingerprint TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,last_seen TEXT,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,content TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions(endpoint TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),content TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries(entry_id TEXT NOT NULL,reminder_at TEXT NOT NULL,endpoint TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT,PRIMARY KEY(entry_id,reminder_at,endpoint));
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,device_id TEXT,action TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
  migrateAccounts(db);migrateOrganizations(db);
  const decode=r=>r?{...JSON.parse(r.content),version:r.version,createdAt:r.created_at,updatedAt:r.updated_at}:null;
  const get=(id,userId)=>decode(userId===undefined?db.prepare('SELECT * FROM entries WHERE id=?').get(id):db.prepare('SELECT * FROM entries WHERE id=? AND user_id=?').get(id,userId));
  const list=userId=>(userId===undefined?db.prepare('SELECT * FROM entries ORDER BY updated_at DESC').all():db.prepare('SELECT * FROM entries WHERE user_id=? ORDER BY updated_at DESC').all(userId)).map(decode);
  function audit(device,action){db.prepare('INSERT INTO audit(device_id,action,created_at) VALUES (?,?,?)').run(device,action,new Date().toISOString());}
  function mutate(input,deviceId,userId){
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    db.exec('SAVEPOINT entry_mutation');
    try{
      const prior=db.prepare('SELECT request_hash,response,user_id FROM operations WHERE id=?').get(input.operationId);
      if(prior){
        const response=JSON.parse(prior.response),sameUser=userId===undefined||prior.user_id===userId;let sameRequest=prior.request_hash===hash;
        // A retried pre-upgrade write may gain schema defaults. Compare its original
        // response under today's schema without accepting different content or owners.
        if(sameUser&&!sameRequest&&response.entry){
          const {version,createdAt,updatedAt,...entry}=response.entry;
          const earlier=mutationSchema.safeParse({operationId:input.operationId,baseVersion:version-1,entry}),current=mutationSchema.safeParse(input);
          sameRequest=earlier.success&&current.success&&JSON.stringify(earlier.data)===JSON.stringify(current.data);
        }
        db.exec('RELEASE entry_mutation');return sameUser&&sameRequest?response:{status:409,error:'操作标识已被使用'};
      }
      const existing=db.prepare('SELECT user_id FROM entries WHERE id=?').get(input.entry.id);
      if(existing&&userId!==undefined&&existing.user_id!==userId){db.exec('ROLLBACK TO entry_mutation; RELEASE entry_mutation');return {status:404,error:'记录不存在'};}
      const old=get(input.entry.id,userId);
      if((old?.version??0)!==input.baseVersion){db.exec('ROLLBACK TO entry_mutation; RELEASE entry_mutation');return {status:409,error:'这条内容已在其他设备更新，请保留两份或选择版本',current:old};}
      if(input.entry.sourceId&&(!get(input.entry.sourceId,userId)||input.entry.sourceId===input.entry.id)){db.exec('ROLLBACK TO entry_mutation; RELEASE entry_mutation');return {status:400,error:'关联记录不存在'};}
      const now=new Date().toISOString(),version=(old?.version??0)+1;
      const value={...input.entry,version,createdAt:old?.createdAt??now,updatedAt:now};
      db.prepare('INSERT INTO entries(id,content,version,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,version=excluded.version,updated_at=excluded.updated_at').run(value.id,JSON.stringify(input.entry),version,value.createdAt,now,userId??null);
      if(old?.reminderAt!==value.reminderAt||value.deletedAt||value.status!=='active')db.prepare("UPDATE deliveries SET state='cancelled' WHERE entry_id=? AND state IN ('pending','retry')").run(value.id);
      if(value.status==='active'&&!value.deletedAt&&value.reminderAt)db.prepare("UPDATE deliveries SET state='pending',attempts=0,next_attempt=0,last_error=NULL WHERE entry_id=? AND reminder_at=? AND state='cancelled'").run(value.id,value.reminderAt);
      const response={status:200,entry:value};
      if(old?.reminderAt!==value.reminderAt||!value.wechatReminder||value.deletedAt||value.status!=='active')db.prepare("UPDATE wechat_deliveries SET state='cancelled',updated_at=? WHERE entry_id=? AND state IN ('pending','retry')").run(now,value.id);
      if(value.status==='active'&&!value.deletedAt&&value.wechatReminder&&value.reminderAt)db.prepare("UPDATE wechat_deliveries SET state='pending',attempts=0,next_attempt=0,last_error=NULL,updated_at=? WHERE entry_id=? AND reminder_at=? AND mode='scheduled' AND state='cancelled'").run(now,value.id,value.reminderAt);
      db.prepare('INSERT INTO operations(id,request_hash,response,created_at,user_id) VALUES (?,?,?,?,?)').run(input.operationId,hash,JSON.stringify(response),now,userId??null);
      audit(deviceId,old?'entry.update':'entry.create');db.exec('RELEASE entry_mutation');return response;
    }catch(e){db.exec('ROLLBACK TO entry_mutation; RELEASE entry_mutation');throw e;}
  }
  function importEntries(records,deviceId,userId){
    db.exec('BEGIN IMMEDIATE');
    try{
      const ids=new Set(records.map(r=>r.entry.id));
      if(ids.size!==records.length)throw new Error('备份包含重复记录');
      for(const {entry} of records){
        if(entry.sourceId&&(entry.sourceId===entry.id||(!ids.has(entry.sourceId)&&!get(entry.sourceId,userId))))throw new Error('备份包含无效关联');
        const existing=db.prepare('SELECT user_id FROM entries WHERE id=?').get(entry.id);
        if(existing&&userId!==undefined&&existing.user_id!==userId)throw new Error('备份记录编号不可使用');
      }
      let imported=0,skipped=0;const now=new Date().toISOString();
      for(const {entry,createdAt} of records){
        if(get(entry.id,userId)){skipped++;continue;}
        db.prepare('INSERT INTO entries(id,content,version,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)').run(entry.id,JSON.stringify(entry),1,createdAt,now,userId??null);imported++;
      }
      audit(deviceId,'backup.import');db.exec('COMMIT');return {imported,skipped};
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function exportData(userId){return {format:'joybeat-me',schemaVersion:1,exportedAt:new Date().toISOString(),entries:list(userId).map(({version,updatedAt,createdAt,...entry})=>({entry,createdAt}))};}
  const forUser=userId=>{if(!userId)throw new Error('Account scope required');return {get:id=>get(id,userId),list:()=>list(userId),mutate:(input,device)=>mutate(input,device,userId),importEntries:(records,device)=>importEntries(records,device,userId),exportData:()=>exportData(userId)};};
  const exportAllData=()=>({format:'joybeat-me-server',schemaVersion:3,exportedAt:new Date().toISOString(),organizationTables:Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name='organizations' OR name GLOB 'org_*')").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name}`).all()])),accounts:db.prepare('SELECT id,email FROM users').all().map(user=>({...user,data:exportData(user.id)}))});
  function transaction(action){db.exec('BEGIN IMMEDIATE');try{const result=action();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  return {db,transaction,get,list,mutate,importEntries,exportData,exportAllData,forUser,audit,close:()=>db.close()};
}
