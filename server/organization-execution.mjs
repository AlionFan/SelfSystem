import {z} from 'zod';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const checklistItemSchema=z.object({id:z.uuid(),text:z.string().trim().min(1,'请填写步骤内容').max(300),required:z.boolean().default(true)}).strict();
export const checklistSchema=z.array(checklistItemSchema).max(40).refine(items=>new Set(items.map(i=>i.id)).size===items.length,'步骤编号不能重复');
export const deliveryUrlSchema=z.string().trim().min(1).max(2048).refine(value=>{
 try{const u=new URL(value);return /^https?:\/\//i.test(value)&&['https:','http:'].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password&&!/[\u0000-\u0020\u007f]/.test(value);}catch{return false;}
},'请填写完整的 HTTP 或 HTTPS 链接，不能包含账号密码');

export function createOrganizationExecution({db,activeMember}){
 function checklist(t){const items=JSON.parse(t.content).checklist||[];if(!items.length)return [];const checks=new Map(db.prepare('SELECT item_id,completed_at,user_id FROM org_checklist_checks WHERE task_id=?').all(t.id).map(r=>[r.item_id,r]));return items.map(i=>({...i,completedAt:checks.get(i.id)?.completed_at||null,completedBy:checks.get(i.id)?.user_id||null}));}
 function progress(t){const items=checklist(t);return {total:items.length,done:items.filter(i=>i.completedAt).length,required:items.filter(i=>i.required).length,requiredDone:items.filter(i=>i.required&&i.completedAt).length};}
 function requireComplete(t){const missing=checklist(t).filter(i=>i.required&&!i.completedAt);if(missing.length)throw fail(`还有 ${missing.length} 个必做步骤未完成，请先检查清单`);}
 function reconcile(t,content){const before=JSON.parse(t.content),old=before.checklist||[],next=content.checklist||[],changed=JSON.stringify(old)!==JSON.stringify(next)||before.acceptanceCriteria!==content.acceptanceCriteria;if(changed&&!['draft','todo','doing'].includes(t.status))throw fail('请先退回或重新打开任务，再修改步骤和验收标准');for(const item of old){const current=next.find(n=>n.id===item.id);if(!current||current.text!==item.text||current.required!==item.required)db.prepare('DELETE FROM org_checklist_checks WHERE task_id=? AND item_id=?').run(t.id,item.id);}return changed;}
 function links(t){return db.prepare('SELECT id,user_id AS userId,label,url,created_at AS createdAt,removed_at AS removedAt FROM org_task_deliverables WHERE task_id=? ORDER BY created_at').all(t.id);}
 function assertExecution(c,t,p){if(!p.submit)throw fail('请由负责人或协作者更新执行进度',403);if(!['todo','doing'].includes(t.status)||t.archived_at)throw fail('当前状态不能修改交付，请先退回或重新打开任务');if(!activeMember(c,t.assignee_id))throw fail('请先分配给正常成员');if(t.accept_required&&!t.accepted_at)throw fail('负责人需要先确认接收');}
 function apply(c,t,p,action,payload){
  if(action==='checklist-check'){
   assertExecution(c,t,p);const v=z.object({itemId:z.uuid(),done:z.boolean()}).strict().parse(payload),item=(JSON.parse(t.content).checklist||[]).find(i=>i.id===v.itemId);if(!item)throw fail('步骤已被修改或移除，请刷新后重试',409);
   if(v.done)db.prepare('INSERT INTO org_checklist_checks(task_id,item_id,user_id,completed_at) VALUES (?,?,?,?) ON CONFLICT(task_id,item_id) DO NOTHING').run(t.id,item.id,c.userId,new Date().toISOString());else db.prepare('DELETE FROM org_checklist_checks WHERE task_id=? AND item_id=?').run(t.id,item.id);return {itemId:item.id,text:item.text,done:v.done};
  }
  if(!['todo','doing'].includes(t.status)||t.archived_at)throw fail('当前状态不能调整交付链接，请先退回或重新打开任务');
  if(!p.manage)assertExecution(c,t,p);
  if(action==='deliverable-add'){
   const v=z.object({id:z.uuid(),label:z.string().trim().min(1).max(100),url:deliveryUrlSchema}).strict().parse(payload);if(db.prepare('SELECT 1 FROM org_task_deliverables WHERE id=?').get(v.id))throw fail('此交付编号已使用，请刷新后重试',409);const all=links(t);if(all.filter(l=>!l.removedAt).length>=20||all.length>=200)throw fail('每项任务最多保留 20 个有效交付链接，请先整理已有链接');db.prepare('INSERT INTO org_task_deliverables(id,org_id,task_id,user_id,label,url,created_at) VALUES (?,?,?,?,?,?,?)').run(v.id,c.orgId,t.id,c.userId,v.label,v.url,new Date().toISOString());return {id:v.id,label:v.label,url:v.url};
  }
  const v=z.object({id:z.uuid(),removed:z.boolean()}).strict().parse(payload),link=db.prepare('SELECT * FROM org_task_deliverables WHERE id=? AND task_id=? AND org_id=?').get(v.id,t.id,c.orgId);if(!link)throw fail('交付链接不存在',404);if(!p.manage&&link.user_id!==c.userId)throw fail('只能调整自己提交的链接',403);if(!v.removed&&link.removed_at&&links(t).filter(l=>!l.removedAt).length>=20)throw fail('有效交付链接已满');db.prepare('UPDATE org_task_deliverables SET removed_at=? WHERE id=?').run(v.removed?new Date().toISOString():null,v.id);return {id:v.id,label:link.label,removed:v.removed};
 }
 return {checklist,progress,requireComplete,reconcile,links,apply};
}
