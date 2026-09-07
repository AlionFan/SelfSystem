import {useEffect,useRef,useState} from 'react';
// Organization text remains in component memory and the author's server draft only.
export function useOrgDraft({api,payload,initial,taskId=null,enabled=true}){
 const [status,setStatus]=useState(initial?'saved':'empty'),[error,setError]=useState('');
 const state=useRef({id:initial?.id||crypto.randomUUID(),version:initial?.version||0,saved:initial?JSON.stringify(initial.payload):'',pending:null,running:null,timer:null,stopped:false,blocked:false}),latest=useRef(),apiRef=useRef(api);apiRef.current=api;latest.current=JSON.stringify(payload);
 const [changed,setChanged]=useState(0);
 async function flush(){const s=state.current;clearTimeout(s.timer);if(s.running){await s.running;if(s.saved!==latest.current)return flush();return;}if(s.blocked)throw new Error('草稿有版本冲突，请先另存当前输入');if(s.stopped||!enabled)return;if(s.saved===latest.current)return;setStatus('saving');setError('');
  s.running=(async()=>{while(!s.stopped&&s.saved!==latest.current){if(!s.pending)s.pending={raw:latest.current,body:{operationId:crypto.randomUUID(),...(s.version?{version:s.version}:{}),data:{id:s.id,taskId,payload:JSON.parse(latest.current)}}};const p=s.pending;const r=await apiRef.current('/actions/work-draft',{method:'POST',body:JSON.stringify(p.body)});s.version=r.version;s.saved=p.raw;s.pending=null;}setStatus('saved');})().catch(e=>{if(e.status===409)s.blocked=true;setStatus(e.status===409?'conflict':'unsaved');setError(e.message);throw e;}).finally(()=>{s.running=null;});return s.running;
 }
 useEffect(()=>{const s=state.current;if(!enabled||s.stopped||s.blocked||s.saved===latest.current)return;setStatus('unsaved');s.timer=setTimeout(()=>flush().catch(()=>{}),1200);return()=>clearTimeout(s.timer);},[JSON.stringify(payload),enabled,changed]);
 useEffect(()=>{const retry=()=>setChanged(n=>n+1),timer=setInterval(retry,15000),warn=e=>{const s=state.current;if(!s.stopped&&enabled&&s.saved!==latest.current){e.preventDefault();e.returnValue='';}};window.addEventListener('online',retry);window.addEventListener('beforeunload',warn);return()=>{clearInterval(timer);clearTimeout(state.current.timer);window.removeEventListener('online',retry);window.removeEventListener('beforeunload',warn);};},[enabled]);
 async function remove(){await flush();const s=state.current;if(s.version)await apiRef.current('/actions/delete-work-draft',{method:'POST',body:JSON.stringify({operationId:crypto.randomUUID(),version:s.version,data:{id:s.id}})});s.stopped=true;setStatus('saved');}
 function stop(){state.current.stopped=true;clearTimeout(state.current.timer);}
 async function fork(){const s=state.current;if(s.running)await s.running.catch(()=>{});s.id=crypto.randomUUID();s.version=0;s.pending=null;s.blocked=false;s.saved='';await flush();}
 function reset(){const s=state.current;clearTimeout(s.timer);Object.assign(s,{id:crypto.randomUUID(),version:0,saved:latest.current,pending:null,running:null,stopped:false,blocked:false});setStatus('empty');}
 return {status,error,flush,remove,stop,fork,reset,state};
}
