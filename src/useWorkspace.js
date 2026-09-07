import { useState,useRef,useEffect,useCallback } from 'react';
import { readState,updateState,recoverLegacyState } from './storage';
import { entryData } from './model';
import { entrySchema } from '../server/schema.mjs';

export function useWorkspace(user){
  const userId=user.id;
  const [state,setState]=useState({entries:[],queue:[],draft:''}),[ready,setReady]=useState(false),[session,setSession]=useState(null),[syncing,setSyncing]=useState(false),[online,setOnline]=useState(navigator.onLine),[error,setError]=useState(''),[locked,setLocked]=useState(false),[conflict,setConflict]=useState(null);
  const current=useRef(state),sessionRef=useRef(null),busy=useRef(false),writes=useRef(Promise.resolve()),blocked=useRef(false),channel=useRef(null),disposed=useRef(false);
  const persist=useCallback(update=>{
    const operation=writes.current.catch(()=>{}).then(async()=>{
      if(disposed.current)return current.current;
      const next=await updateState(userId,update);current.current=next;setState(next);channel.current?.postMessage('saved');return next;
    });writes.current=operation;return operation;
  },[userId]);
  const api=useCallback(async(url,options={})=>{
    if(disposed.current)throw new Error('此页面已关闭，请重新登录');
    const response=await fetch(url,{...options,headers:{'X-Me-Account':userId,...options.headers,...(options.body?{'Content-Type':'application/json','X-Me-CSRF':sessionRef.current?.csrf??''}:{})}});
    if(response.status===401){window.dispatchEvent(new Event('me-auth-required'));const e=new Error('请重新登录');e.status=401;throw e;}
    const data=await response.json();if(data.code==='ACCOUNT_CHANGED')window.dispatchEvent(new Event('me-auth-required'));if(!response.ok){const e=new Error(data.error??'请求未完成');e.status=response.status;e.data=data;throw e;}return data;
  },[userId]);
  const sync=useCallback(async()=>{
    if(disposed.current||busy.current||blocked.current)return;busy.current=true;setSyncing(true);
    try{
      const bootResponse=await fetch('/api/bootstrap',{headers:{'X-Me-Account':userId}});
      if(disposed.current)return;
      if(bootResponse.status===401||bootResponse.status===409){window.dispatchEvent(new Event('me-auth-required'));throw new Error('请重新登录');}
      if(bootResponse.status===403){setLocked(true);throw new Error('登录状态已失效，请重新登录');}
      if(!bootResponse.ok)throw new Error('服务器暂时不可用，本机内容已保留');
      const boot=await bootResponse.json();if(boot.user?.id!==userId){window.dispatchEvent(new Event('me-auth-required'));throw new Error('账号已切换');}sessionRef.current=boot;setSession(boot);setLocked(false);setOnline(true);
      while(current.current.queue.length){
        const operation=current.current.queue[0];
        try{
          const result=await api('/api/mutations',{method:'POST',body:JSON.stringify(operation)});
          await persist(previous=>{
            const queue=previous.queue.filter(q=>q.operationId!==operation.operationId);
            const later=queue.some(q=>q.entry.id===result.entry.id);
            return {...previous,queue,entries:later?previous.entries:previous.entries.map(e=>e.id===result.entry.id?result.entry:e)};
          });
        }catch(e){
          if(e.status===409){blocked.current=true;setConflict({operation,current:e.data.current,error:e.message});}
          throw e;
        }
      }
      const data=await api('/api/entries');
      await persist(previous=>{
        const pending=new Map(previous.queue.map(q=>[q.entry.id,previous.entries.find(e=>e.id===q.entry.id)]));
        const map=new Map(data.entries.map(e=>[e.id,e]));for(const e of previous.entries){const remote=map.get(e.id);if(remote&&e.version>remote.version)map.set(e.id,e);}for(const [id,e] of pending)if(e)map.set(id,e);
        return {...previous,entries:[...map.values()],lastSync:new Date().toISOString()};
      });setError('');
    }catch(e){setOnline(navigator.onLine);setError(e.message.includes('fetch')?'网络暂时不可用，内容已保留在本机':e.message);}
    finally{busy.current=false;setSyncing(false);}
  },[api,persist,userId]);
  useEffect(()=>{
    disposed.current=false;
    const bus='BroadcastChannel'in window?new BroadcastChannel('joybeat-me-state:'+userId):null;channel.current=bus;
    if(bus)bus.onmessage=()=>{writes.current=writes.current.catch(()=>{}).then(async()=>{const fresh=await readState(userId);current.current=fresh;setState(fresh);});};
    let alive=true;recoverLegacyState(user).then(()=>readState(userId)).then(data=>{if(!alive)return;current.current=data;setState(data);setReady(true);sync();}).catch(()=>{setError('浏览器存储不可用，请退出无痕模式或检查剩余空间');});
    const onOnline=()=>{setOnline(true);sync();},onOffline=()=>setOnline(false),onFocus=()=>{if(document.visibilityState==='visible')sync();};
    window.addEventListener('online',onOnline);window.addEventListener('offline',onOffline);document.addEventListener('visibilitychange',onFocus);
    const timer=setInterval(()=>{if(document.visibilityState==='visible')sync();},20000);
    return()=>{alive=false;disposed.current=true;bus?.close();channel.current=null;clearInterval(timer);window.removeEventListener('online',onOnline);window.removeEventListener('offline',onOffline);document.removeEventListener('visibilitychange',onFocus);};
  },[sync,userId]);
  async function save(entry){
    if(blocked.current)throw new Error('请先处理同步冲突，再继续修改');
    const validated=entrySchema.safeParse(entryData(entry));
    if(!validated.success){const field=validated.error.issues[0]?.path[0];throw new Error(field==='tags'?'每个标签最多 30 个字符':validated.error.issues[0]?.message??'内容格式无效');}
    const updated=await persist(previous=>{
      const old=previous.entries.find(e=>e.id===entry.id),version=entry.version??old?.version??0,now=new Date().toISOString();
      const operation={operationId:crypto.randomUUID(),baseVersion:version,entry:validated.data};
      const value={...validated.data,version:version+1,createdAt:old?.createdAt??now,updatedAt:now,pending:true};
      return {...previous,entries:[value,...previous.entries.filter(e=>e.id!==entry.id)],queue:[...previous.queue,operation]};
    });sync();return updated.entries.find(e=>e.id===entry.id);
  }
  async function flush(){for(let attempt=0;attempt<30;attempt++){await sync();if(!current.current.queue.length)return;if(blocked.current)throw new Error('请先解决编辑冲突');await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('内容仍待上传，请同步完成后再发送微信提醒');}
  async function resolveConflict(choice){
    const {operation,current:remote}=conflict;
    await persist(previous=>{
      const allForEntry=previous.queue.filter(q=>q.entry.id===operation.entry.id),latest=allForEntry.at(-1)?.entry??operation.entry;
      let queue=previous.queue.filter(q=>q.entry.id!==operation.entry.id),entries=previous.entries.filter(e=>e.id!==operation.entry.id);
      if(remote)entries.push(remote);
      if(choice==='both'){
        const copy={...latest,id:crypto.randomUUID(),title:latest.title?`${latest.title} · 本机副本`:'',sourceId:latest.sourceId===latest.id?null:latest.sourceId};
        queue.push({operationId:crypto.randomUUID(),baseVersion:0,entry:copy});entries.push({...copy,version:1,pending:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
      }
      return {...previous,queue,entries};
    });blocked.current=false;setConflict(null);sync();
  }
  return {state,ready,session,syncing,online,error,locked,conflict,save,sync,flush,api,resolveConflict,stop:async()=>{disposed.current=true;await writes.current.catch(()=>{});},setDraft:async draft=>persist(previous=>({...previous,draft})),setEditorDraft:async editorDraft=>persist(previous=>({...previous,editorDraft}))};
}
