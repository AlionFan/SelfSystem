import React,{useEffect,useState} from 'react';
import {Sparkles,LoaderCircle,RotateCcw,ArrowUpRight} from 'lucide-react';
import {titleOf} from './model';
const names={pending:'等待 AI 整理',running:'AI 正在整理',applied:'AI 已整理',failed:'原文已保留',stale:'已保留你的修改',cancelled:'已按原文保存',undone:'已撤销整理'};
const kinds={auto:'默认',note:'想法',task:'待办',event:'日程'};
export function AiActivity({ai,workspace,onEdit,notify}){
  const job=ai.jobs?.[0];
  if(!job)return null;const entry=workspace.state.entries.find(e=>e.id===job.entryId);
  if(!entry||entry.deletedAt)return null;
  const waiting=['pending','running'].includes(job.state);
  return <div className="ai-activity" role="status">{waiting?<LoaderCircle size={15} className="spin"/>:<Sparkles size={15}/>}<span><strong>{names[job.state]}</strong><small>{ai.error||(job.state==='applied'?`${job.resultIds.length} 项 · ${titleOf(entry)}`:job.error||titleOf(entry))}</small></span><button className="text-button" onClick={()=>onEdit(entry)}>查看<ArrowUpRight size={13}/></button>{job.canUndo&&<button className="text-button" disabled={ai.busy||!workspace.online} onClick={()=>ai.undo(job.id).then(()=>notify('已恢复原始记录')).catch(()=>{})}>撤销</button>}</div>;
}
export function AiDetails({entry,ai,workspace,dirty,onClose,notify}){
  const [job,setJob]=useState(null),[kind,setKind]=useState(entry.captureMode||entry.kind),[error,setError]=useState('');
  const latest=workspace.state.entries.find(e=>e.id===entry.id),changed=latest&&latest.version!==entry.version;
  useEffect(()=>{let alive=true;workspace.api(`/api/ai/entries/${entry.id}`).then(data=>{if(alive)setJob(data.job);}).catch(()=>{});return()=>{alive=false;};},[entry.id,ai.jobs]);
  const original=job?.originalBody||entry.originalBody;
  return <section className="ai-details"><div className="ai-details-head"><Sparkles size={15}/><span>{job?names[job.state]:'AI 整理'}</span>{job?.canUndo&&<button type="button" className="text-button" disabled={dirty||ai.busy||!workspace.online} onClick={()=>ai.undo(job.id).then(()=>{notify('已恢复原始记录');onClose();}).catch(e=>setError(e.message))}><RotateCcw size={13}/>撤销整理</button>}</div>
    {entry.aiSummary&&<p>{entry.aiSummary}</p>}{job?.advice?.length>0&&<p className="ai-advice">{job.advice.join('；')}</p>}{job?.error&&<p className="ai-advice">{job.error}</p>}
    {original&&<details><summary>查看原始记录</summary><pre>{original}</pre></details>}
    {changed&&<p className="ai-advice">内容已在云端更新。关闭后重新打开可查看最新结果；当前编辑仍会保留为草稿。</p>}
    {entry.version&&<div className="ai-retry"><label>整理类别<select aria-label="AI 整理类别" value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(kinds).map(([id,name])=><option value={id} key={id}>{name}</option>)}</select></label><button type="button" className="button secondary" disabled={dirty||changed||ai.busy||!workspace.online||!ai.configured||!ai.enabled||['pending','running'].includes(job?.state)} onClick={()=>ai.analyze(entry,kind).then(()=>{notify('已交给 AI 整理');onClose();}).catch(e=>setError(e.message))}>重新整理</button></div>}
    {dirty&&<small>先保存修改，再重新整理或撤销。</small>}{error&&<p className="form-error" role="alert">{error}</p>}
  </section>;
}
export function AiSettings({ai,notify}){
  const [consent,setConsent]=useState(false),[error,setError]=useState('');
  const change=data=>ai.preferences(data).then(()=>{setError('');notify('AI 设置已保存');}).catch(e=>setError(e.message));
  return <section className="ai-settings"><div className="settings-section-title"><Sparkles size={19}/><h3>AI 整理</h3><span className={`pill ${ai.enabled&&ai.configured?'green':''}`}>{!ai.configured?'待配置':ai.enabled?'已开启':'已关闭'}</span></div><p className="muted">使用阿里云百炼 Qwen-Flash 整理记录。仅发送当前内容、所选类别和记录时间，原文保留在本站。</p>{ai.enabled?<button type="button" className="text-button" disabled={ai.busy} onClick={()=>change({enabled:false})}>关闭自动整理</button>:<><label className="consent-label"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>我同意将新记录发送给阿里云百炼进行 AI 整理。</label><button type="button" className="button secondary" disabled={!consent||!ai.configured||ai.busy} onClick={()=>change({enabled:true,consent:true})}>开启自动整理</button></>}
    <label className="consent-label"><input type="checkbox" checked={Boolean(ai.wechatAuto)} disabled={ai.busy||!ai.enabled} onChange={e=>change({wechatAuto:e.target.checked})}/>识别到明确的提醒要求和时间时，使用已连接的微信提醒。</label><p className="settings-footnote">今日已用 {ai.dailyUsed??0} / {ai.dailyLimit??100} 次。关闭 AI、离线或额度用完时仍可保存原文。</p>{error&&<p className="form-error">{error}</p>}</section>;
}
