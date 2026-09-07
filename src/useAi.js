import {useCallback,useEffect,useRef,useState} from 'react';
export function useAi(workspace){
  const [state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),signature=useRef('');
  const refresh=useCallback(async()=>{
    const next=await workspace.api('/api/ai');setState(next);setError('');
    const key=next.jobs.map(j=>`${j.id}:${j.state}`).join('|');
    if(signature.current&&key!==signature.current)await workspace.sync();signature.current=key;return next;
  },[workspace.api,workspace.sync]);
  useEffect(()=>{
    let alive=true;
    const load=async()=>{try{if(alive&&document.visibilityState==='visible')await refresh();}catch{}};
    load();const timer=setInterval(load,4000);return()=>{alive=false;clearInterval(timer);};
  },[refresh]);
  async function run(action){setBusy(true);setError('');try{const result=await action();await workspace.sync();await refresh();return result;}catch(e){setError(e.message);throw e;}finally{setBusy(false);}}
  return {...state,state,error,busy,refresh,
    preferences:data=>run(()=>workspace.api('/api/ai/preferences',{method:'PATCH',body:JSON.stringify(data)})),
    analyze:(entry,kind)=>run(async()=>{await workspace.flush();return workspace.api(`/api/ai/entries/${entry.id}/analyze`,{method:'POST',body:JSON.stringify({version:entry.version,kind})});}),
    undo:id=>run(async()=>{await workspace.flush();return workspace.api(`/api/ai/jobs/${id}/undo`,{method:'POST',body:'{}'});})
  };
}
