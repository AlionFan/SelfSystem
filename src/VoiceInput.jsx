import {useEffect,useRef,useState} from 'react';
import {Mic,Square,LoaderCircle,X,RotateCcw} from 'lucide-react';
import {voiceSupport,startMicrophone,recordingToWav,requestTranscript} from './voice';

const clock=seconds=>`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
const microphoneError=error=>error.name==='NotAllowedError'?'麦克风权限未开启，请在浏览器的网站设置中允许麦克风后重试':error.name==='NotFoundError'?'没有找到麦克风，请连接麦克风后重试':error.name==='NotReadableError'?'麦克风正被其他应用占用，请关闭后重试':error.message;
export function VoiceInput({workspace,onTranscript,onOpen,onBusy,disabled=false}){
  const [phase,setPhase]=useState('idle'),[error,setError]=useState(''),[seconds,setSeconds]=useState(0);
  const current=useRef({}),callbacks=useRef({onTranscript,onBusy,onOpen});callbacks.current={onTranscript,onBusy,onOpen};
  const busy=['permission','recording','converting','transcribing'].includes(phase),opened=phase!=='idle';
  useEffect(()=>{callbacks.current.onBusy(busy);},[busy]);
  useEffect(()=>{
    const visibility=()=>{if(document.visibilityState!=='hidden')return;const run=current.current;if(run.recording)run.recording.stop();else if(run.controller&&!run.clip&&!run.blob){run.cancelled=true;run.controller.abort();setPhase('consent');}};
    document.addEventListener('visibilitychange',visibility);
    return()=>{current.current.cancelled=true;current.current.controller?.abort();callbacks.current.onBusy(false);document.removeEventListener('visibilitychange',visibility);};
  },[]);
  function cancel(){current.current.cancelled=true;current.current.controller?.abort();current.current={};setError('');setPhase('idle');}
  function open(){callbacks.current.onOpen();setError('');setPhase('consent');}
  async function transcribe(run,retry=false){
    if(run.cancelled)return;
    setPhase('transcribing');setError('');
    try{
      if(!run.clip){setPhase('converting');run.clip={id:crypto.randomUUID(),bytes:await recordingToWav(run.blob)};run.blob=null;if(run.cancelled)return;setPhase('transcribing');}
      const text=await requestTranscript(workspace.api,run.clip,{signal:run.controller.signal,retry});
      if(run.cancelled)return;
      if(callbacks.current.onTranscript(text)===false){setError('草稿已接近字数上限，请先保存草稿，再点击“重试”取回文字');setPhase('error');return;}
      current.current={};setPhase('idle');
    }catch(e){if(!run.cancelled){setError(e.name==='AbortError'?'转写等待超时，请重试取回结果':e.message.includes('fetch')?'网络暂时不可用，录音保留在此页面，恢复后可重试':e.message);setPhase('error');}}
  }
  async function start(){
    if(busy)return;
    const run={controller:new AbortController(),cancelled:false};current.current=run;setError('');setSeconds(0);setPhase('permission');
    let timer;
    try{
      if(!navigator.onLine)throw new Error('语音转写需要联网，请恢复网络后重试');
      if(!voiceSupport())throw new Error('此浏览器暂不支持录音，请用新版 Chrome、Edge 或 Safari 打开');
      const status=await workspace.api('/api/voice',{signal:run.controller.signal});if(run.cancelled)return;
      if(!status.configured)throw new Error('语音输入暂未配置，请稍后再试');
      run.recording=await startMicrophone({signal:run.controller.signal});if(run.cancelled)return;
      setPhase('recording');const stamp=Date.now();timer=setInterval(()=>setSeconds(Math.min(120,Math.floor((Date.now()-stamp)/1000))),250);
      run.blob=await run.recording.done;run.recording=null;clearInterval(timer);if(run.cancelled)return;
      // Backgrounding stops the microphone but leaves upload for an explicit tap.
      if(document.visibilityState==='hidden'){setPhase('ready');return;}
      await transcribe(run);
    }catch(e){if(!run.cancelled){setError(microphoneError(e));setPhase('error');}}finally{clearInterval(timer);}
  }
  const retry=()=>current.current.clip||current.current.blob?transcribe(current.current,true):start();
  return <><button type="button" className={`icon-button voice-trigger ${opened?'active':''}`} aria-label="语音输入" title="语音输入" aria-expanded={opened} disabled={disabled||opened} onClick={open}><Mic size={18}/></button>{opened&&<div className="voice-panel" aria-label="语音输入面板">
    <div className="voice-status" role="status">{phase==='recording'?<><span className="voice-recording-dot"/><strong>正在录音</strong><span>{clock(seconds)} / 2:00</span></>:busy?<><LoaderCircle size={16} className="spin"/><span>{phase==='permission'?'正在准备麦克风…':phase==='converting'?'正在处理录音…':'正在转成文字…'}</span></>:<span>{phase==='ready'?'录音已暂停，可以转成文字':phase==='error'?'语音输入未完成':'说完后，文字会先放入草稿'}</span>}<button type="button" className="icon-button" aria-label="取消语音输入" onClick={cancel}><X size={17}/></button></div>
    {phase==='consent'&&<p>录音将发送到阿里云百炼转写，Me 不保存原始录音。单次最多两分钟。</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="voice-actions">{phase==='consent'&&<button type="button" className="button primary" onClick={start}><Mic size={16}/>同意并开始录音</button>}{phase==='recording'&&<button type="button" className="button primary" onClick={()=>current.current.recording?.stop()}><Square size={14}/>停止并转文字</button>}{phase==='ready'&&<button type="button" className="button primary" onClick={()=>transcribe(current.current)}>转成文字</button>}{phase==='error'&&<button type="button" className="button secondary" onClick={retry}><RotateCcw size={15}/>重试</button>}{['recording','transcribing','ready','error'].includes(phase)&&<button type="button" className="text-button" onClick={cancel}>取消</button>}</div>
  </div>}</>;
}
