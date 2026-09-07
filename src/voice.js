import {encodeVoiceWav,voiceMaxSeconds,voiceSampleRate} from '../server/voice-audio.mjs';

export function voiceSupport(env=globalThis){
  return Boolean(env.isSecureContext&&env.navigator?.mediaDevices?.getUserMedia&&typeof env.MediaRecorder==='function'&&(env.OfflineAudioContext||env.webkitOfflineAudioContext));
}
export async function startMicrophone({signal,env=globalThis,maxSeconds=voiceMaxSeconds}){
  if(!voiceSupport(env))throw new Error('此浏览器暂不支持录音，请用新版 Chrome、Edge 或 Safari 打开');
  const stream=await env.navigator.mediaDevices.getUserMedia({audio:{channelCount:{ideal:1},echoCancellation:{ideal:true},noiseSuppression:{ideal:true},autoGainControl:{ideal:true}},video:false});
  let released=false;
  const release=()=>{if(released)return;released=true;stream.getTracks().forEach(track=>track.stop());};
  if(signal.aborted){release();throw new DOMException('Cancelled','AbortError');}
  let recorder,timer,settled=false,bytes=0;
  const chunks=[];
  let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b;});
  // Attach immediately so cancellation during setup cannot create an unhandled rejection.
  done.catch(()=>{});
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);release();if(error)reject(error);else resolve(new Blob(chunks,{type:recorder.mimeType}));};
  const cancel=()=>{if(recorder?.state==='recording')recorder.stop();finish(new DOMException('Cancelled','AbortError'));};
  const stop=()=>{if(recorder?.state==='recording'){try{recorder.requestData?.();}catch{}recorder.stop();}};
  try{
    const supportsMime=typeof env.MediaRecorder.isTypeSupported==='function'?type=>env.MediaRecorder.isTypeSupported(type):()=>false;
    const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(supportsMime);
    recorder=new env.MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:64000});
    recorder.ondataavailable=e=>{if(settled||!e.data.size)return;bytes+=e.data.size;if(bytes>16*1024*1024){cancel();return;}chunks.push(e.data);};
    recorder.onstop=()=>finish();recorder.onerror=()=>{stop();finish(new Error('录音中断，请检查麦克风后重录'));};
    for(const track of stream.getTracks())track.addEventListener('ended',stop,{once:true});
    signal.addEventListener('abort',cancel,{once:true});recorder.start(1000);timer=setTimeout(stop,maxSeconds*1000);
    return {stop,done};
  }catch(error){finish(error);throw error;}
}
export async function recordingToWav(blob){
  if(!blob.size)throw new Error('录音为空，请重新录制');
  const Context=globalThis.OfflineAudioContext||globalThis.webkitOfflineAudioContext;
  const context=new Context(1,1,voiceSampleRate);
  let decoded;try{decoded=await context.decodeAudioData(await blob.arrayBuffer());}catch{throw new Error('此浏览器无法读取录音，请换用新版 Chrome、Edge 或 Safari');}
  if(decoded.duration<0.5)throw new Error('录音太短，请多说一句再试');
  // A delayed browser timer can overshoot the limit; keep exactly the first two minutes.
  const count=Math.min(decoded.length,voiceMaxSeconds*voiceSampleRate),samples=new Float32Array(count);
  for(let channel=0;channel<decoded.numberOfChannels;channel++){const data=decoded.getChannelData(channel);for(let i=0;i<count;i++)samples[i]+=data[i]/decoded.numberOfChannels;}
  return encodeVoiceWav(samples);
}
export function audioBase64(bytes){let value='';for(let i=0;i<bytes.length;i+=0x8000)value+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(value);}
export function appendTranscript(draft,text){return draft?draft+(draft.endsWith('\n')?'':'\n')+text:text;}

export async function requestTranscript(api,clip,{signal,retry=false}={}){
  const request=async(url,options={})=>{const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,75000);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();try{return await api(url,{...options,signal:controller.signal});}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}};
  // After a dropped connection, retrieve the original result before any paid retry.
  let result;
  if(clip.submitted){try{result=await request('/api/voice/jobs/'+clip.id,{signal});}catch(error){if(error.status!==404)throw error;}}
  if(result&&['failed','expired'].includes(result.state)&&retry){clip.id=crypto.randomUUID();result=null;clip.submitted=false;}
  if(!result){clip.submitted=true;result=await request('/api/voice/transcribe',{method:'POST',signal,body:JSON.stringify({id:clip.id,audio:audioBase64(clip.bytes),consent:true})});}
  for(let i=0;result.state==='processing'&&i<45;i++){
    await new Promise((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},1500);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});
    result=await request('/api/voice/jobs/'+clip.id,{signal});
  }
  if(result.state!=='done')throw new Error(result.error||'转写仍在进行，稍后点击重试可取回结果');
  return result.text;
}
