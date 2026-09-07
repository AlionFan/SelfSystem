import {dayKey} from './model.js';

const dayMs=86400000;
const minuteMs=60000;
const dayNumber=day=>Date.parse(`${day}T00:00:00+08:00`)/dayMs;
const localStamp=(date,time)=>Date.parse(`${date}T${time}:00+08:00`);
export const boardDays=today=>Array.from({length:7},(_,i)=>dayKey(new Date((dayNumber(today)+i)*dayMs)));

export function initialQuadrant(entry){
  return ['urgent-important','important','urgent','later'].includes(entry.quadrant)?entry.quadrant:'unassigned';
}

export function phaseFor(entry,phases={}){
  if(entry.status==='done')return 'done';
  if(['todo','doing'].includes(entry.phase))return entry.phase;
  if(['todo','doing'].includes(phases?.[entry.id]))return phases[entry.id];
  return 'todo';
}

// Events use an exclusive end, just like the calendar view.
export function ganttRange(entry,today){
  const start=entry.kind==='event'?(entry.startAt?dayKey(new Date(entry.startAt)):entry.scheduledDate):entry.scheduledDate||entry.focusDate||entry.dueDate;
  if(!start)return null;
  const end=entry.kind==='event'?(entry.endAt?dayKey(new Date(Date.parse(entry.endAt)-1)):start):entry.dueDate||start;
  const first=dayNumber(start)-dayNumber(today);
  const last=Math.max(first,dayNumber(end)-dayNumber(today));
  if(!Number.isFinite(first)||!Number.isFinite(last)||first>6||last<0)return null;
  const startIndex=Math.max(0,first),endIndex=Math.min(6,last);
  return {startIndex,endIndex,span:endIndex-startIndex+1};
}

// Prefer an exact time window for timed tasks/events. Date-only entries keep the
// day-level fallback above so old content and deadline-only tasks remain visible.
export function ganttTimeRange(entry,today){
  const windowStart=Date.parse(`${today}T00:00:00+08:00`),windowEnd=windowStart+7*dayMs;
  let startStamp,endStamp;
  if(entry.kind==='event'){
    startStamp=entry.startAt?Date.parse(entry.startAt):null;
    endStamp=entry.endAt?Date.parse(entry.endAt):entry.durationMinutes&&startStamp?startStamp+entry.durationMinutes*minuteMs:null;
  }else{
    startStamp=entry.scheduledDate&&entry.scheduledTime?localStamp(entry.scheduledDate,entry.scheduledTime):null;
    if(startStamp){
      if(entry.durationMinutes)endStamp=startStamp+entry.durationMinutes*minuteMs;
      else if(entry.dueDate&&entry.dueTime)endStamp=localStamp(entry.dueDate,entry.dueTime);
      else if(entry.dueTime)endStamp=localStamp(entry.scheduledDate,entry.dueTime);
      else if(entry.dueDate)endStamp=Date.parse(`${entry.dueDate}T00:00:00+08:00`)+dayMs;
    }
  }
  if(!Number.isFinite(startStamp)||!Number.isFinite(endStamp)||endStamp<=startStamp||endStamp<=windowStart||startStamp>=windowEnd)return null;
  const startMinutes=Math.max(0,(startStamp-windowStart)/minuteMs),endMinutes=Math.min(7*24*60,(endStamp-windowStart)/minuteMs);
  if(endMinutes<=startMinutes)return null;
  return {startMinutes,endMinutes,leftPercent:startMinutes/(7*24*60)*100,widthPercent:(endMinutes-startMinutes)/(7*24*60)*100};
}
