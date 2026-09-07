import React,{useEffect,useRef,useState} from 'react';
import {Sun,CheckSquare,CalendarDays,Check,CalendarClock,GripVertical,ArrowLeftRight} from 'lucide-react';
import {dateLabel,timeLabel,durationLabel,titleOf} from './model.js';
import {boardDays,ganttRange,ganttTimeRange,initialQuadrant,phaseFor} from './board-model.js';
import {createBoardDrag} from './board-drag.js';

const modes=[['quadrant','四象限',Sun],['kanban','任务看板',CheckSquare],['gantt','甘特图',CalendarDays]];
const quadrants=[
  {id:'urgent-important',label:'重要 · 紧急',tone:'rose'},
  {id:'important',label:'重要 · 不紧急',tone:'moss'},
  {id:'urgent',label:'不重要 · 紧急',tone:'amber'},
  {id:'later',label:'不重要 · 不紧急',tone:'slate'}
];
const phases=[{id:'todo',label:'待开始'},{id:'doing',label:'进行中'},{id:'done',label:'已完成'}];
const unassigned={id:'unassigned',label:'待分配',tone:'unassigned'};
function readLayout(user){
  try{
    const value=JSON.parse(localStorage.getItem('joybeat-board-layout-v2:'+user.id)||(user.role==='owner'?localStorage.getItem('joybeat-board-layout-v1'):null)||'{}');
    return value&&typeof value==='object'?value:{};
  }catch{return {};}
}

function BoardCard({entry,onEdit,onChange,nativeStart,endDrag,touch,onMove,dragging}){
  const done=entry.status==='done';
  const taskMeta=[entry.scheduledDate||entry.scheduledTime?`计划 ${entry.scheduledDate?dateLabel(entry.scheduledDate):'日期待补'}${entry.scheduledTime?` ${entry.scheduledTime}`:''}`:'',entry.durationMinutes?`持续 ${durationLabel(entry.durationMinutes)}`:'',entry.dueDate||entry.dueTime?`${entry.dueDate?dateLabel(entry.dueDate):'日期待补'}${entry.dueTime?` ${entry.dueTime}`:''} 截止`:''].filter(Boolean).join(' · ');
  return <article className={`board-card ${dragging?'is-dragging':''} ${done?'is-done':''}`} draggable onDragStart={event=>nativeStart(event,entry.id)} onDragEnd={endDrag}>
    <button className="board-card-grip" aria-label={`调整重要度：${titleOf(entry)}`} title="拖动移动；手机长按，点击可修改四象限" onContextMenu={event=>event.preventDefault()} onPointerDown={event=>touch.down(event,entry.id)} onPointerMove={touch.move} onPointerUp={touch.up} onPointerCancel={touch.cancel} onLostPointerCapture={touch.cancel} onClick={()=>{if(!touch.consumeClick())onMove(entry);}}><GripVertical size={18}/></button>
    {entry.kind==='task'?<button className={`task-check ${done?'checked':''}`} aria-label={`${done?'重新打开':'完成'}：${titleOf(entry)}`} onClick={()=>onChange({...entry,status:done?'active':'done',inbox:false})}>{done&&<Check size={13}/>}</button>:<span className="board-card-kind event"><CalendarClock size={16}/></span>}
    <button className="board-card-main" onClick={()=>onEdit(entry)}><strong>{titleOf(entry)}</strong>{(entry.dueDate||entry.dueTime||entry.startAt||entry.startTime||entry.endTime||entry.scheduledDate||entry.scheduledTime)&&<span className="board-card-meta">{entry.kind==='event'?`${dateLabel(entry.startAt||entry.scheduledDate)||'日期待补'} · ${entry.allDay?'全天':entry.startAt?`${timeLabel(entry.startAt)}${entry.endAt?` – ${timeLabel(entry.endAt)}`:''}`:entry.startTime||entry.endTime||'时间待补'}`:taskMeta}</span>}{entry.pending&&<span className="pending-dot" title="等待同步"/>}</button>
  </article>;
}

function GanttView({entries,today,onEdit}){
  const [zoom,setZoom]=useState(1);
  const days=boardDays(today);
  const items=entries.map(entry=>({entry,timeRange:ganttTimeRange(entry,today),dateRange:ganttRange(entry,today)})).filter(item=>item.timeRange||item.dateRange).sort((a,b)=>(a.timeRange?.startMinutes??a.dateRange.startIndex*24*60)-(b.timeRange?.startMinutes??b.dateRange.startIndex*24*60));
  const undated=entries.filter(entry=>entry.kind==='event'?!entry.startAt&&!entry.scheduledDate:!entry.scheduledDate&&!entry.focusDate&&!entry.dueDate);
  function adjustZoom(delta){setZoom(value=>Math.min(3,Math.max(.75,Math.round((value+delta)*100)/100)));}
  return <>
    <div className="gantt-view" tabIndex={0} role="region" aria-label="接下来 7 天的时间甘特图，可横向滚动"><div className="gantt-grid" style={{minWidth:`${760*zoom}px`}}><div className="gantt-row gantt-head"><span className="gantt-head-label"><span>接下来 7 天</span><span className="gantt-zoom-controls" aria-label="甘特图缩放"><button type="button" aria-label="缩小甘特图" title="缩小" onClick={()=>adjustZoom(-.25)} disabled={zoom<=.75}>−</button><span aria-live="polite">{Math.round(zoom*100)}%</span><button type="button" aria-label="放大甘特图" title="放大" onClick={()=>adjustZoom(.25)} disabled={zoom>=3}>＋</button><button type="button" aria-label="重置甘特图缩放" title="重置" onClick={()=>setZoom(1)} disabled={zoom===1}>重置</button></span></span><div className="gantt-days">{days.map((day,index)=><span key={day} className={index===0?'today':''}><b>{index===0?'今天':day.slice(5).replace('-',' / ')}</b><small>{['日','一','二','三','四','五','六'][new Date(`${day}T12:00:00+08:00`).getUTCDay()]} · 00　06　12　18</small></span>)}</div></div>
      {items.map(({entry,timeRange,dateRange})=>{const range=timeRange??{leftPercent:dateRange.startIndex*100/7,widthPercent:dateRange.span*100/7};return <div className="gantt-row" key={entry.id}><button className="gantt-label" onClick={()=>onEdit(entry)}><span>{entry.kind==='event'?'日程':'待办'}{entry.durationMinutes?` · 持续 ${durationLabel(entry.durationMinutes)}`:''}</span><strong>{titleOf(entry)}</strong></button><div className="gantt-track"><button className={`gantt-bar ${entry.kind} ${entry.status==='done'?'done':''}`} aria-label={`编辑：${titleOf(entry)}`} onClick={()=>onEdit(entry)} style={{left:`${range.leftPercent}%`,width:`${range.widthPercent}%`}}>{titleOf(entry)}</button></div></div>;})}
    </div>{!items.length&&<div className="board-empty">接下来 7 天暂无安排</div>}</div>
    {undated.length>0&&<details className="gantt-undated"><summary>未安排日期 · {undated.length}</summary><div>{undated.map(entry=><button key={entry.id} onClick={()=>onEdit(entry)}>{titleOf(entry)}<CalendarDays size={14}/></button>)}</div></details>}
  </>;
}

export function Board({entries,today,onEdit,onChange,user,Modal}){
  const [layout]=useState(()=>readLayout(user));
  const [mode,setMode]=useState(()=>modes.some(([id])=>id===layout.mode)?layout.mode:'quadrant');
  const [dragId,setDragId]=useState(null),[dropTarget,setDropTarget]=useState(''),[moveEntry,setMoveEntry]=useState(null);
  const dragRef=useRef(null),touchRef=useRef(null),dropRef=useRef(null);
  const migrated=useRef(new Set());
  const boardEntries=entries.filter(entry=>entry.kind!=='note'&&!entry.deletedAt&&['active','done'].includes(entry.status));
  const choices=mode==='quadrant'?[unassigned,...quadrants]:phases;
  const visible=mode==='quadrant'?boardEntries.filter(entry=>entry.status==='active'):boardEntries.filter(entry=>entry.kind==='task');
  const kind=mode==='quadrant'?'quadrant':'phase';
  useEffect(()=>{try{localStorage.setItem('joybeat-board-layout-v2:'+user.id,JSON.stringify({...layout,mode}));}catch{}},[layout,mode,user.id]);
  useEffect(()=>{
    for(const entry of boardEntries){
      if(entry.pending||migrated.current.has(entry.id))continue;
      const oldQuadrant=entry.quadrant===undefined&&quadrants.some(q=>q.id===layout.quadrants?.[entry.id])?layout.quadrants[entry.id]:undefined;
      const oldPhase=entry.phase===undefined&&['todo','doing'].includes(layout.phases?.[entry.id])?layout.phases[entry.id]:undefined;
      if(oldQuadrant===undefined&&oldPhase===undefined)continue;
      migrated.current.add(entry.id);onChange({...entry,...(oldQuadrant?{quadrant:oldQuadrant}:{}),...(oldPhase?{phase:oldPhase}:{})});
    }
  },[entries]);
  function endDrag(){dragRef.current=null;setDragId(null);setDropTarget('');}
  function completeDrop(target,id){
    const [kind,value]=(target||'').split(':');
    const valid=(kind==='quadrant'?[unassigned,...quadrants]:kind==='phase'?phases:[]).some(choice=>choice.id===value);
    const entry=boardEntries.find(item=>item.id===id);
    if(!valid||!entry)return;
    if(kind==='quadrant')onChange({...entry,quadrant:value==='unassigned'?null:value});
    if(kind==='phase'&&entry.kind==='task'){
      onChange({...entry,status:value==='done'?'done':'active',phase:value==='done'?(entry.phase||'todo'):value,inbox:false});
    }
    endDrag();
  }
  dropRef.current=completeDrop;
  if(!touchRef.current)touchRef.current=createBoardDrag({onStart:id=>{dragRef.current=id;setDragId(id);},onTarget:setDropTarget,onDrop:(target,id)=>dropRef.current(target,id),onEnd:endDrag});
  useEffect(()=>()=>touchRef.current.cancel(),[]);
  function nativeStart(event,id){dragRef.current=id;setDragId(id);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',id);}
  function position(entry){
    if(mode==='kanban')return phaseFor(entry,layout.phases);
    const saved=entry.quadrant===undefined?layout.quadrants?.[entry.id]:null;
    return quadrants.some(q=>q.id===saved)?saved:initialQuadrant(entry,today);
  }
  return <section className="board-section" aria-label="事件展板"><div className="board-heading"><h1>展板</h1><div className="board-switcher" role="group" aria-label="展板视图">{modes.map(([id,label,Icon])=><button key={id} aria-pressed={mode===id} className={mode===id?'active':''} onClick={()=>{touchRef.current.cancel();endDrag();setMode(id);}}><Icon size={16}/><span>{label}</span></button>)}</div><span className="board-drag-hint"><GripVertical size={14}/><span>拖动移动<span className="touch-hint"> · 手机长按</span></span></span></div>
    {mode!=='gantt'?<div className={mode==='quadrant'?'quadrant-grid':'kanban-grid'}>{choices.filter(choice=>choice.id!=='unassigned'||visible.some(entry=>position(entry)==='unassigned')||dragId).map(choice=>{
      const target=`${kind}:${choice.id}`,items=visible.filter(entry=>position(entry)===choice.id);
      return <section key={choice.id} aria-label={choice.label} data-drop-target={target} className={`board-dropzone ${choice.tone||choice.id} ${dropTarget===target?'is-over':''}`} onDragOver={event=>{if(dragRef.current){event.preventDefault();event.dataTransfer.dropEffect='move';setDropTarget(target);}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget))setDropTarget('');}} onDrop={event=>{event.preventDefault();completeDrop(target,dragRef.current);}}><header className="quadrant-head"><span className={`quadrant-dot ${choice.tone||choice.id}`}/><h2>{choice.label}</h2><small>{items.length}</small></header><div className="quadrant-cards">{items.map(entry=><BoardCard key={entry.id} entry={entry} onEdit={onEdit} onChange={onChange} nativeStart={nativeStart} endDrag={endDrag} touch={touchRef.current} onMove={setMoveEntry} dragging={dragId===entry.id}/>)}</div>{!items.length&&<div className="quadrant-empty">暂无事项</div>}</section>;
    })}</div>:<GanttView entries={boardEntries} today={today} onEdit={onEdit}/>}
    {moveEntry&&<Modal title="移动到" onClose={()=>setMoveEntry(null)}><div className="board-move-options"><p>{titleOf(moveEntry)}</p>{choices.map(choice=><button key={choice.id} onClick={()=>{completeDrop(`${kind}:${choice.id}`,moveEntry.id);setMoveEntry(null);}}><ArrowLeftRight size={16}/>{choice.label}{position(moveEntry)===choice.id&&<Check size={16}/>}</button>)}</div></Modal>}
  </section>;
}
