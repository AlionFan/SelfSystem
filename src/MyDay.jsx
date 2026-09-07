import React,{useEffect,useState} from 'react';
import {dayItems} from './org-productivity';
import {dayKey} from './model';
export function MyDay({workspace,user,onPersonal,onOrganization}){
 const [tasks,setTasks]=useState([]),[warning,setWarning]=useState(''),[filter,setFilter]=useState('all');
 useEffect(()=>{let alive=true;async function refresh(){try{const r=await workspace.api('/api/organizations/mine');if(alive){setTasks(r.tasks);setWarning('');}}catch(e){if(alive){if([401,403,404].includes(e.status))setTasks([]);setWarning('组织任务暂未更新，联网后自动重试');}}}refresh();const timer=setInterval(refresh,20000);window.addEventListener('online',refresh);return()=>{alive=false;clearInterval(timer);window.removeEventListener('online',refresh);};},[workspace.api]);
 const items=dayItems(workspace.state.entries,tasks,dayKey(),user.id),visible=items.filter(i=>filter==='all'||(filter==='personal'?!i.task:!!i.task));
 return <section className="org-personal-tasks"><div className="section-heading"><h2>我的一天 <span>{items.length}</span></h2><div className="filter-tabs">{[['all','全部'],['personal','个人'],['organization','组织']].map(([k,v])=><button key={k} className={filter===k?'active':''} onClick={()=>setFilter(k)}>{v}</button>)}</div></div>{warning&&<p className="org-hint">{warning}</p>}{visible.map(i=><button className="org-personal-row" key={i.id} onClick={()=>i.task?onOrganization({orgId:i.task.orgId,taskId:i.id}):onPersonal(i.entry)}><strong>{i.title}</strong><span><b>{i.reason}</b> · {i.source}{i.date?' · '+i.date:''}</span></button>)}{!visible.length&&<p className="org-hint">今日计划、到期事项、待接收和待验收的任务会在这里汇总。</p>}</section>;
}
