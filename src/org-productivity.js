const dayRank={'已逾期':0,'待我接收':1,'待我验收':2,'今日到期':3,'今日重点':4,'今日计划':5};
export const fieldNames={kind:'类别',title:'标题',body:'正文',tags:'标签',scheduledDate:'计划日期',scheduledTime:'计划时刻',dueDate:'截止日期',dueTime:'截止时刻',durationMinutes:'预计投入',startAt:'日程开始',endAt:'日程结束',allDay:'全天',quadrant:'组织优先级',acceptanceCriteria:'验收标准',checklist:'检查清单'};
export function prepareAiItems(original,suggestions,manualFields){
 const fields=new Set(manualFields.filter(k=>k!=='body'&&k in fieldNames));
 return suggestions.map((item,index)=>index?{...item}:{...item,...Object.fromEntries([...fields].map(k=>[k,original[k]]))});
}
export function assignmentChoices(home,value){
 const selected=[value.projectId,value.departmentId].filter(Boolean),scopes=home.scopes.filter(s=>selected.includes(s.id));
 const manager=home.admin||scopes.length>0&&scopes.every(s=>s.leadId===home.me.id);
 const members=home.members.filter(m=>m.state==='active'&&(home.admin||manager&&scopes.every(s=>s.memberIds.includes(m.id))||m.id===home.me.id));
 const reviewers=home.members.filter(m=>m.state==='active'&&m.id!==value.assigneeId&&!value.collaboratorIds.includes(m.id)&&(['owner','admin'].includes(m.role)||scopes.some(s=>s.leadId===m.id)));
 return {manager,members,reviewers,scopes:home.scopes.filter(s=>home.admin||s.memberIds.includes(home.me.id)||s.leadId===home.me.id)};
}
const localDay=instant=>new Date(Date.parse(instant)+8*3600000).toISOString().slice(0,10);
const eventOnDay=(c,today)=>c.kind==='event'&&c.startAt&&localDay(c.startAt)<=today&&localDay(new Date(Date.parse(c.endAt||c.startAt)-(c.endAt?1:0)).toISOString())>=today;
export function dayItems(entries,tasks,today,userId){
 const items=[];
 for(const e of entries){if(e.deletedAt||e.status!=='active'||e.kind==='note')continue;const date=e.dueDate||e.scheduledDate;const todayEvent=eventOnDay(e,today);
  const reason=e.dueDate&&e.dueDate<today?'已逾期':e.dueDate===today?'今日到期':e.focusDate===today?'今日重点':e.scheduledDate===today||todayEvent?'今日计划':null;if(reason)items.push({id:e.id,source:'个人',title:e.title||e.body.split('\n')[0],reason,date,rank:dayRank[reason],entry:e});}
 for(const t of tasks){if(['done','cancelled','draft'].includes(t.status)||t.archivedAt)continue;const own=t.assigneeId===userId||t.collaboratorIds.includes(userId),c=t.content;
  const reason=t.status==='review'&&t.permissions.review?'待我验收':own&&t.acceptRequired&&!t.acceptedAt?'待我接收':own&&c.dueDate&&c.dueDate<today?'已逾期':own&&c.dueDate===today?'今日到期':t.preference.focusDate===today?'今日重点':own&&(c.scheduledDate===today||eventOnDay(c,today))?'今日计划':null;
  if(reason)items.push({id:t.id,source:t.organizationName,title:c.title,reason,date:c.dueDate||c.scheduledDate,rank:dayRank[reason],task:t});}
 return items.sort((a,b)=>a.rank-b.rank||(a.date||'9999').localeCompare(b.date||'9999')||a.id.localeCompare(b.id));
}
