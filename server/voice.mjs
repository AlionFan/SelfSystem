import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {inspectVoiceWav,voiceMaxBytes,voiceMaxSeconds} from './voice-audio.mjs';

const endpoint='https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const inputSchema=z.object({id:z.uuid(),audio:z.string().min(1).max(Math.ceil(voiceMaxBytes/3)*4).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(v=>v.length%4===0),consent:z.literal(true)}).strict();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const dayKey=stamp=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(stamp));
export function createVoice({store,config,fetchOverride=fetch,now=()=>Date.now()}){
  const db=store.db,configured=Boolean(config?.enabled&&config?.apiKey&&config?.voiceEnabled!==false);
  const dailySeconds=config?.voiceDailySeconds??1200,budget=Math.round((config?.monthlyBudgetYuan??20)*1e6);let active=0;
  const view=row=>({id:row.id,state:row.state,...(row.state==='done'?{text:row.transcript}:{}),...(row.error?{error:row.error}:{})});
  function cleanup(){
    db.prepare("UPDATE voice_jobs SET state='expired',transcript=NULL,error='转写结果已过期，请重新转写' WHERE state='done' AND updated_at<?").run(now()-600000);
    db.prepare("UPDATE voice_jobs SET state='failed',error='上次转写被中断，请重试',updated_at=? WHERE state='processing' AND updated_at<?").run(now(),now()-90000);
    db.prepare("DELETE FROM voice_jobs WHERE updated_at<? AND state<>'processing'").run(now()-86400000);
  }
  function status(userId){const day=dayKey(now());return {configured,maxSeconds:voiceMaxSeconds,dailySeconds,usedSeconds:db.prepare('SELECT COALESCE(SUM(seconds),0) AS n FROM voice_usage WHERE user_id=? AND day_key=?').get(userId,day).n};}
  function result(userId,id,scope=null){scope?.validate();cleanup();const row=db.prepare('SELECT * FROM voice_jobs WHERE user_id=? AND id=?').get(userId,id);if(!row||(row.org_id??null)!==(scope?.orgId??null))throw fail('转写记录不存在',404);return view(row);}
  async function transcribe(userId,input,scope=null){
    scope?.validate();
    if(!configured)throw fail('语音输入暂未配置，请稍后再试',503);
    const {id,audio}=inputSchema.parse(input);cleanup();
    const bytes=Buffer.from(audio,'base64'),{seconds}=inspectVoiceWav(bytes),digest=createHash('sha256').update(bytes).digest('hex');
    const previous=db.prepare('SELECT * FROM voice_jobs WHERE user_id=? AND id=?').get(userId,id);
    if(previous){if((previous.org_id??null)!==(scope?.orgId??null))throw fail('转写记录不存在',404);if(previous.digest!==digest)throw fail('这次录音已变更，请重新转写',409);return view(previous);}
    if(active>=2)throw fail('语音服务正忙，请稍后重试',429);
    store.transaction(()=>{
      const day=dayKey(now()),month=day.slice(0,7),chargedSeconds=Math.ceil(seconds),cost=chargedSeconds*220;
      const usage=db.prepare('SELECT COALESCE(SUM(seconds),0) AS seconds,COUNT(*) AS count FROM voice_usage WHERE user_id=? AND day_key=?').get(userId,day);
      const global=db.prepare('SELECT COALESCE(SUM(seconds),0) AS seconds FROM voice_usage WHERE day_key=?').get(day).seconds;
      const spent=db.prepare('SELECT (SELECT COALESCE(SUM(cost_micros),0) FROM ai_usage WHERE month_key=?)+(SELECT COALESCE(SUM(cost_micros),0) FROM voice_usage WHERE month_key=?) AS n').get(month,month).n;
      if(scope){const orgSpent=db.prepare('SELECT (SELECT COALESCE(SUM(cost_micros),0) FROM ai_usage WHERE month_key=? AND org_id=?)+(SELECT COALESCE(SUM(cost_micros),0) FROM voice_usage WHERE month_key=? AND org_id=?) AS n').get(month,scope.orgId,month,scope.orgId).n;if(orgSpent+cost>scope.budgetYuan*1e6)throw fail('组织语音与 AI 额度已用完',429);}
      if(usage.seconds+chargedSeconds>dailySeconds||usage.count>=100||global+chargedSeconds>18000||spent+cost>budget)throw fail('语音转写额度已用完，可以继续打字记录',429);
      db.prepare("INSERT INTO voice_jobs(user_id,id,digest,state,updated_at,org_id) VALUES (?,?,?,'processing',?,?)").run(userId,id,digest,now(),scope?.orgId??null);
      db.prepare('INSERT INTO voice_usage(id,user_id,day_key,month_key,seconds,cost_micros,org_id) VALUES (?,?,?,?,?,?,?)').run(randomUUID(),userId,day,month,chargedSeconds,cost,scope?.orgId??null);
    });
    active++;
    try{
      const response=await fetchOverride(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.apiKey}`},body:JSON.stringify({model:'qwen3-asr-flash',messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'data:audio/wav;base64,'+audio}}]}],stream:false,asr_options:{enable_itn:true}})});
      if(!response.ok)throw fail(response.status===401||response.status===403?'语音服务配置需要检查':response.status===429?'语音服务繁忙，请稍后重试':'语音转写暂时不可用，请稍后重试',503);
      const raw=await response.text();if(raw.length>100000)throw fail('转写结果过长，请分段录制');
      const answer=JSON.parse(raw),text=answer.choices?.[0]?.message?.content;
      if(typeof text!=='string'||!text.trim())throw fail('没有识别到语音，请靠近麦克风后重录');
      if(text.length>8000||answer.choices?.[0]?.finish_reason!=='stop')throw fail('转写未完整完成，请分段录制');
      scope?.validate();
      db.prepare("UPDATE voice_jobs SET state='done',transcript=?,updated_at=? WHERE user_id=? AND id=?").run(text.trim(),now(),userId,id);
    }catch(error){
      db.prepare("UPDATE voice_jobs SET state='failed',error=?,updated_at=? WHERE user_id=? AND id=?").run(error.status?error.message:'转写未完成，请检查网络后重试',now(),userId,id);
    }finally{active--;}
    return result(userId,id,scope);
  }
  return {configured,status,result,transcribe,cleanup};
}
