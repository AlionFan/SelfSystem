import test from 'node:test';
import assert from 'node:assert/strict';
import {boardDays,ganttRange,ganttTimeRange,phaseFor,initialQuadrant} from '../src/board-model.js';
import {createBoardDrag} from '../src/board-drag.js';

const today='2026-09-06';
test('Gantt clips overlapping ranges and excludes dates outside the visible week',()=>{
  assert.deepEqual(boardDays(today),['2026-09-06','2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-12']);
  assert.equal(ganttRange({kind:'task'},today),null);
  assert.equal(ganttRange({kind:'task',dueDate:'2026-09-13'},today),null);
  assert.equal(ganttRange({kind:'task',dueDate:'2026-09-05'},today),null);
  assert.deepEqual(ganttRange({kind:'task',scheduledDate:'2026-09-01',dueDate:'2026-09-20'},today),{startIndex:0,endIndex:6,span:7});
  assert.deepEqual(ganttRange({kind:'task',scheduledDate:'2026-09-08',dueDate:'2026-09-10'},today),{startIndex:2,endIndex:4,span:3});
  assert.deepEqual(ganttRange({kind:'task',focusDate:today},today),{startIndex:0,endIndex:0,span:1});
});
test('Gantt uses Beijing dates and does not add a day to midnight event endings',()=>{
  assert.deepEqual(ganttRange({kind:'event',startAt:'2026-09-05T16:00:00Z',endAt:'2026-09-06T16:00:00Z'},today),{startIndex:0,endIndex:0,span:1});
  assert.equal(ganttRange({kind:'event',startAt:'2026-09-04T16:00:00Z',endAt:'2026-09-05T16:00:00Z'},today),null);
});
test('completed and reopened tasks override stale saved columns',()=>{
  assert.equal(phaseFor({id:'a',status:'done'},{a:'todo'}),'done');
  assert.equal(phaseFor({id:'a',status:'active'},{a:'done'}),'todo');
  assert.equal(phaseFor({id:'a',status:'active',focusDate:today},{a:'done'}),'todo');
  assert.equal(phaseFor({id:'a',status:'active',focusDate:today},{a:'todo'}),'todo');
});
function fixture(){
  const timers=new Map(),frames=new Map(),events=[];let next=0,captured=false,target='quadrant:later';
  const env={setTimeout(fn){timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),requestAnimationFrame(fn){frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id),scrollBy:(x,y)=>events.push(['scroll',y]),innerHeight:800,document:{elementFromPoint:()=>({closest:()=>({dataset:{dropTarget:target}})})}};
  const drag=createBoardDrag({env,onStart:id=>events.push(['start',id]),onTarget:t=>events.push(['target',t]),onDrop:(t,id)=>events.push(['drop',t,id]),onEnd:()=>events.push(['end'])});
  const element={setPointerCapture:()=>captured=true,hasPointerCapture:()=>captured,releasePointerCapture:()=>captured=false};
  const event=(extra={})=>({pointerType:'touch',pointerId:1,clientX:50,clientY:300,currentTarget:element,preventDefault(){},...extra});
  const hold=()=>{for(const [id,fn] of timers){timers.delete(id);fn();}};
  return {drag,event,hold,events,timers,frames,target:value=>target=value,captured:()=>captured};
}
test('touch requires a hold, cancels early movement, and releases capture',()=>{
  const f=fixture();f.drag.down(f.event(),'a');f.drag.up(f.event());f.hold();
  assert.equal(f.events.some(e=>e[0]==='drop'||e[0]==='start'),false);assert.equal(f.captured(),false);
  f.drag.down(f.event(),'a');f.drag.move(f.event({clientY:330}));f.hold();
  assert.equal(f.events.some(e=>e[0]==='start'),false);assert.equal(f.drag.consumeClick(),true);
});
test('long hold drops once in the destination and suppresses the subsequent tap',()=>{
  const f=fixture();f.drag.down(f.event(),'a');f.hold();f.target('quadrant:important');f.drag.move(f.event({clientX:400}));f.drag.up(f.event());
  assert.deepEqual(f.events.filter(e=>e[0]==='drop'),[['drop','quadrant:important','a']]);assert.equal(f.frames.size,0);assert.equal(f.captured(),false);assert.equal(f.drag.consumeClick(),true);assert.equal(f.drag.consumeClick(),false);
});
test('pointer cancellation and unmount do not commit a drop or leave auto scroll running',()=>{
  const f=fixture();f.drag.down(f.event({clientY:770}),'a');f.hold();assert.ok(f.events.some(e=>e[0]==='scroll'));
  f.drag.cancel();f.drag.up(f.event());assert.equal(f.events.some(e=>e[0]==='drop'),false);assert.equal(f.frames.size,0);assert.equal(f.timers.size,0);assert.equal(f.captured(),false);
});

test('cloud placement is authoritative and missing event times remain undated',()=>{
  assert.equal(initialQuadrant({kind:'task',dueDate:today}), 'unassigned');
  assert.equal(initialQuadrant({quadrant:'important'}), 'important');
  assert.equal(phaseFor({id:'a',phase:'doing'},{a:'todo'}),'doing');
  assert.equal(ganttRange({kind:'event',startAt:null,endAt:null},today),null);
  assert.deepEqual(ganttRange({kind:'event',scheduledDate:today},today),{startIndex:0,endIndex:0,span:1});
});
test('timed Gantt ranges use task time and duration before date-only fallback',()=>{
  const morning=ganttTimeRange({kind:'task',scheduledDate:today,scheduledTime:'09:00',durationMinutes:60},today);
  const afternoon=ganttTimeRange({kind:'task',scheduledDate:today,scheduledTime:'14:00',durationMinutes:90},today);
  assert.deepEqual(morning,{startMinutes:540,endMinutes:600,leftPercent:540/(7*24*60)*100,widthPercent:60/(7*24*60)*100});
  assert.equal(afternoon.startMinutes,840);assert.equal(afternoon.endMinutes,930);assert.ok(afternoon.leftPercent>morning.leftPercent);
  assert.equal(ganttTimeRange({kind:'task',scheduledDate:today,dueDate:'2026-09-08'},today),null);
  assert.equal(ganttTimeRange({kind:'task',scheduledDate:today,scheduledTime:'09:00',dueDate:today,dueTime:'18:00'},today).endMinutes,1080);
});
