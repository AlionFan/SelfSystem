export const dayKey=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export function entryData(entry){const {version,createdAt,updatedAt,pending,startDate,endDate,reminderDate,reminderTime,...data}=entry;return data;}
export function blankEntry(kind='note',body=''){return {id:crypto.randomUUID(),kind,body,title:'',tags:[],quadrant:null,phase:'todo',captureMode:null,capturedAt:null,originalBody:null,aiSummary:'',status:'active',inbox:true,focusDate:null,scheduledDate:null,scheduledTime:null,durationMinutes:null,dueDate:null,dueTime:null,startAt:null,endAt:null,startTime:null,endTime:null,allDay:false,reminderAt:null,wechatReminder:false,sourceId:null,deletedAt:null};}
export const titleOf=e=>e.title||e.body.split('\n')[0];
export function dateLabel(value){if(!value)return '';const date=new Date(value.length===10?`${value}T12:00:00+08:00`:value);return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'}).format(date);}
export function timeLabel(value){return value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'';}
export function durationLabel(minutes){if(!minutes)return '';if(minutes%1440===0)return `${minutes/1440}天`;if(minutes%60===0)return `${minutes/60}小时`;return `${Math.floor(minutes/60)?`${Math.floor(minutes/60)}小时`:''}${minutes%60}分钟`;}
export function localDateTime(value){if(!value)return '';return `${dayKey(new Date(value))}T${timeLabel(value)}`;}
export function fromLocal(value){return value?new Date(`${value}:00+08:00`).toISOString():null;}
