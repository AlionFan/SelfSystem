import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {orgDate,taskContentSchema,taskAssignmentSchema} from './organization-schema.mjs';
const json=JSON.stringify,parse=JSON.parse,stamp=()=>new Date().toISOString();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const shanghaiDay=(now=Date.now())=>new Date(now+8*3600000).toISOString().slice(0,10);
const dateNumber=s=>Date.parse(s+'T00:00:00Z');
const addDays=(s,n)=>new Date(dateNumber(s)+n*86400000).toISOString().slice(0,10);
export const repeatSchema=z.object({frequency:z.enum(['daily','weekdays','weekly','monthly']),interval:z.number().int().min(1).max(12).default(1),startDate:orgDate,endDate:orgDate.nullable().default(null)}).strict().refine(v=>!v.endDate||v.endDate>=v.startDate,'结束日期不能早于开始日期');
// Always calculate from the original anchor, so Jan 31 -> Feb 28 -> Mar 31.
export function occurrenceOnOrAfter(rule,date){
 if(rule.endDate&&date>rule.endDate)return null;
 let next;
 if(rule.frequency==='monthly'){
  const anchor=new Date(dateNumber(rule.startDate)),target=new Date(dateNumber(date));
  let n=Math.max(0,Math.floor(((target.getUTCFullYear()-anchor.getUTCFullYear())*12+target.getUTCMonth()-anchor.getUTCMonth())/rule.interval));
  const at=i=>{const y=anchor.getUTCFullYear(),m=anchor.getUTCMonth()+i*rule.interval,d=Math.min(anchor.getUTCDate(),new Date(Date.UTC(y,m+1,0)).getUTCDate());return new Date(Date.UTC(y,m,d)).toISOString().slice(0,10);};
  next=at(n);if(next<date)next=at(n+1);
 }else if(rule.frequency==='weekdays'){
  next=date>rule.startDate?date:rule.startDate;while([0,6].includes(new Date(dateNumber(next)).getUTCDay()))next=addDays(next,1);
 }else{
  const step=rule.interval*(rule.frequency==='weekly'?7:1),n=Math.max(0,Math.ceil((dateNumber(date)-dateNumber(rule.startDate))/86400000/step));next=addDays(rule.startDate,n*step);
 }
 return rule.endDate&&next>rule.endDate?null:next;
}
export function occurrenceContent(content,anchor,date){
 const delta=(dateNumber(date)-dateNumber(anchor))/86400000,shift=d=>d?addDays(d,delta):null;
 return taskContentSchema.parse({...content,scheduledDate:shift(content.scheduledDate)||date,dueDate:shift(content.dueDate),startAt:content.startAt?new Date(Date.parse(content.startAt)+delta*86400000).toISOString():null,endAt:content.endAt?new Date(Date.parse(content.endAt)+delta*86400000).toISOString():null});
}
export function createOrganizationProductivity({store,context,task,allowed,checkAssignment,perform,audit}){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS org_work_drafts(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,user_id TEXT NOT NULL,task_id TEXT,payload TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS org_work_draft_owner ON org_work_drafts(org_id,user_id);
 CREATE TABLE IF NOT EXISTS org_templates(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,user_id TEXT NOT NULL,name TEXT NOT NULL,content TEXT NOT NULL,assignment TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS org_repeats(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,user_id TEXT NOT NULL,name TEXT NOT NULL,content TEXT NOT NULL,assignment TEXT NOT NULL,rule TEXT NOT NULL,next_date TEXT,state TEXT NOT NULL DEFAULT 'active',error TEXT,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS org_repeat_due ON org_repeats(state,next_date);
 CREATE TABLE IF NOT EXISTS org_repeat_occurrences(repeat_id TEXT NOT NULL,occurrence_date TEXT NOT NULL,task_id TEXT NOT NULL UNIQUE,PRIMARY KEY(repeat_id,occurrence_date));`);
 function owned(c,table,id){const row=db.prepare(`SELECT * FROM ${table} WHERE id=? AND org_id=? AND user_id=?`).get(id,c.orgId,c.userId);if(!row)throw fail('内容不存在或不属于当前账号',404);return row;}
 function check(row,version){if(row.version!==version)throw fail('另一台设备已更新，请保留当前输入并重新打开最新版本',409);}
 function draft(c,id){const d=owned(c,'org_work_drafts',id);if(d.task_id)task(c,d.task_id);return {id:d.id,taskId:d.task_id,payload:parse(d.payload),version:d.version,updatedAt:d.updated_at};}
 function library(c){return {drafts:db.prepare('SELECT id,task_id AS taskId,version,updated_at AS updatedAt,payload FROM org_work_drafts WHERE org_id=? AND user_id=? ORDER BY updated_at DESC').all(c.orgId,c.userId).filter(d=>{try{if(d.taskId)task(c,d.taskId);return true;}catch{return false;}}).map(d=>{const p=parse(d.payload);return {id:d.id,taskId:d.taskId,version:d.version,updatedAt:d.updatedAt,title:p.content?.title||p.content?.body?.slice(0,60)||p.edit?.payload?.title||(d.taskId?parse(task(c,d.taskId).content).title:null)||'未完成的编辑'};}),templates:db.prepare('SELECT * FROM org_templates WHERE org_id=? AND user_id=? ORDER BY created_at DESC').all(c.orgId,c.userId).map(r=>({id:r.id,name:r.name,version:r.version,content:parse(r.content),assignment:parse(r.assignment)})),repeats:db.prepare('SELECT * FROM org_repeats WHERE org_id=? AND user_id=? ORDER BY created_at DESC').all(c.orgId,c.userId).map(r=>({id:r.id,name:r.name,version:r.version,rule:parse(r.rule),nextDate:r.next_date,state:r.state,error:r.error}))};}
 const actions=new Set(['work-draft','delete-work-draft','publish-work-draft','template','delete-template','repeat','repeat-state']);
 function mutate(c,w,action){const d=w.data;
  if(action==='work-draft'){
   const v=z.object({id:z.uuid(),taskId:z.uuid().nullable().default(null),payload:z.record(z.string(),z.unknown())}).strict().parse(d),raw=json(v.payload);
   if(Buffer.byteLength(raw)>150000)throw fail('草稿过长，请分批记录');
   if(v.taskId){const t=task(c,v.taskId);if(!allowed(c,t).edit&&!allowed(c,t).execute)throw fail('当前任务不允许保留编辑',403);}
   const old=db.prepare('SELECT * FROM org_work_drafts WHERE id=?').get(v.id);
   if(old){owned(c,'org_work_drafts',v.id);if(old.task_id!==v.taskId)throw fail('草稿来源不可变更',409);if(old.payload===raw)return {draftId:old.id,version:old.version};check(old,w.version);}
   else {if(w.version)throw fail('草稿已发布或删除，请重新打开',409);if(db.prepare('SELECT COUNT(*) AS n FROM org_work_drafts WHERE org_id=? AND user_id=?').get(c.orgId,c.userId).n>=50)throw fail('最多保留 50 份草稿，请先整理草稿箱');}
   db.prepare('INSERT INTO org_work_drafts(id,org_id,user_id,task_id,payload,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,version=org_work_drafts.version+1,updated_at=excluded.updated_at').run(v.id,c.orgId,c.userId,v.taskId,raw,stamp());return {draftId:v.id,version:(old?.version||0)+1};
  }
  if(action==='delete-work-draft'){const v=z.object({id:z.uuid()}).strict().parse(d),old=owned(c,'org_work_drafts',v.id);check(old,w.version);db.prepare('DELETE FROM org_work_drafts WHERE id=?').run(v.id);return {};}
  if(action==='publish-work-draft'){const v=z.object({draftId:z.uuid(),tasks:z.unknown(),sourceId:z.uuid().optional(),sourceVersion:z.number().int().positive().optional()}).strict().parse(d),old=owned(c,'org_work_drafts',v.draftId);check(old,w.version);if(old.task_id)throw fail('请在原任务中保存编辑');const {draftId,...data}=v;const result=perform(c,'create-tasks',{data});db.prepare('DELETE FROM org_work_drafts WHERE id=?').run(draftId);return result;}
  if(action==='template'){
   const v=z.object({id:z.uuid(),name:z.string().trim().min(1).max(60),content:taskContentSchema,assignment:taskAssignmentSchema}).strict().parse(d);checkAssignment(c,v.assignment,{publishing:false});if(db.prepare('SELECT COUNT(*) AS n FROM org_templates WHERE org_id=? AND user_id=?').get(c.orgId,c.userId).n>=50)throw fail('最多保存 50 个模板');if(db.prepare('SELECT id FROM org_templates WHERE id=?').get(v.id))throw fail('模板编号已使用',409);db.prepare('INSERT INTO org_templates(id,org_id,user_id,name,content,assignment,created_at) VALUES (?,?,?,?,?,?,?)').run(v.id,c.orgId,c.userId,v.name,json(v.content),json(v.assignment),stamp());return {templateId:v.id};
  }
  if(action==='delete-template'){const v=z.object({id:z.uuid()}).strict().parse(d),old=owned(c,'org_templates',v.id);check(old,w.version);db.prepare('DELETE FROM org_templates WHERE id=?').run(v.id);return {};}
  if(action==='repeat'){
   const v=z.object({id:z.uuid(),templateId:z.uuid(),rule:repeatSchema}).strict().parse(d),t=owned(c,'org_templates',v.templateId);if(v.rule.startDate<shanghaiDay())throw fail('首次生成日期不能早于今天');if(!occurrenceOnOrAfter(v.rule,v.rule.startDate))throw fail('所选日期内没有可生成的重复任务');if(v.rule.frequency==='weekdays'&&v.rule.interval!==1)throw fail('工作日按每周一至五重复');const a=parse(t.assignment);checkAssignment(c,a);if(!a.assigneeId)throw fail('重复任务需要先设置负责人');if(db.prepare('SELECT COUNT(*) AS n FROM org_repeats WHERE org_id=? AND user_id=?').get(c.orgId,c.userId).n>=50)throw fail('最多保留 50 个重复计划');if(db.prepare('SELECT id FROM org_repeats WHERE id=?').get(v.id))throw fail('重复计划编号已使用',409);
   const content=parse(t.content),anchor=content.scheduledDate||content.dueDate||(content.startAt?shanghaiDay(Date.parse(content.startAt)):null)||v.rule.startDate,shifted=occurrenceContent(content,anchor,v.rule.startDate);
   db.prepare('INSERT INTO org_repeats(id,org_id,user_id,name,content,assignment,rule,next_date,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(v.id,c.orgId,c.userId,t.name,json(shifted),t.assignment,json(v.rule),occurrenceOnOrAfter(v.rule,v.rule.startDate),stamp());audit(c,'repeat.create',{id:v.id,rule:v.rule});return {repeatId:v.id};
  }
  if(action==='repeat-state'){const v=z.object({id:z.uuid(),state:z.enum(['active','paused','finished'])}).strict().parse(d),r=owned(c,'org_repeats',v.id);check(r,w.version);if(r.state==='finished')throw fail('已结束的计划不可恢复，请新建');if(v.state==='active')checkAssignment(c,parse(r.assignment));const next=occurrenceOnOrAfter(parse(r.rule),r.next_date&&r.next_date>shanghaiDay()?r.next_date:shanghaiDay());db.prepare('UPDATE org_repeats SET state=?,next_date=?,error=NULL,version=version+1 WHERE id=?').run(!next?'finished':v.state,next,v.id);audit(c,'repeat.state',{id:v.id,state:v.state});return {};}
 }
 function tick(now=Date.now()){
  const today=shanghaiDay(now);
  for(const row of db.prepare("SELECT * FROM org_repeats WHERE state='active' AND next_date<=? ORDER BY next_date LIMIT 50").all(today)){
   try{store.transaction(()=>{const c=context(row.user_id,row.org_id),rule=parse(row.rule),date=occurrenceOnOrAfter(rule,today);checkAssignment(c,parse(row.assignment));
    // Downtime skips historical slots; only today's occurrence is created.
    if(date===today&&!db.prepare('SELECT 1 FROM org_repeat_occurrences WHERE repeat_id=? AND occurrence_date=?').get(row.id,date)){
     const id=randomUUID();perform(c,'create-tasks',{data:{tasks:[{id,content:occurrenceContent(parse(row.content),rule.startDate,date),assignment:parse(row.assignment),publish:true}]}});
     db.prepare('INSERT INTO org_repeat_occurrences VALUES (?,?,?)').run(row.id,date,id);db.prepare("UPDATE org_tasks SET source='repeat' WHERE id=?").run(id);audit(c,'repeat.generated',{repeatId:row.id,taskId:id,date});
    }
    const next=date===today?occurrenceOnOrAfter(rule,addDays(today,1)):date;db.prepare('UPDATE org_repeats SET next_date=?,state=?,version=version+1 WHERE id=?').run(next,next?'active':'finished',row.id);
   });}catch{db.prepare("UPDATE org_repeats SET state='paused',error='成员、分配范围或组织状态已变化，请检查后恢复',version=version+1 WHERE id=?").run(row.id);}
  }
 }
 return {actions,mutate,draft,library,tick};
}
