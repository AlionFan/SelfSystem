// Only the handle disables touch scrolling. The rest of each card scrolls normally.
export function createBoardDrag({onStart,onTarget,onDrop,onEnd,env=window}){
  let pointer=null,frame=null,suppressClick=false;
  const targetAt=()=>env.document.elementFromPoint(pointer.x,pointer.y)?.closest('[data-drop-target]')?.dataset.dropTarget||'';
  function release(){
    if(!pointer)return;
    env.clearTimeout(pointer.timer);
    if(frame!==null)env.cancelAnimationFrame(frame);
    frame=null;
    const old=pointer;pointer=null;
    if(old.element.hasPointerCapture?.(old.pointerId))old.element.releasePointerCapture(old.pointerId);
    onEnd();
  }
  function tick(){
    if(!pointer?.dragging)return;
    // Leave room for the fixed navigation at both edges on phones.
    const speed=pointer.y<110?-Math.min(14,(110-pointer.y)/4):pointer.y>env.innerHeight-140?Math.min(14,(pointer.y-env.innerHeight+140)/4):0;
    if(speed)env.scrollBy(0,speed);
    onTarget(targetAt());
    frame=env.requestAnimationFrame(tick);
  }
  return {
    down(event,id){
      if(event.pointerType==='mouse'||event.isPrimary===false)return;
      release();suppressClick=false;
      const current={id,pointerId:event.pointerId,x:event.clientX,y:event.clientY,initialX:event.clientX,initialY:event.clientY,element:event.currentTarget,dragging:false};
      pointer=current;
      current.element.setPointerCapture?.(current.pointerId);
      current.timer=env.setTimeout(()=>{
        if(pointer!==current)return;
        current.dragging=true;suppressClick=true;onStart(id);
        env.navigator?.vibrate?.(10);tick();
      },420);
    },
    move(event){
      if(!pointer||pointer.pointerId!==event.pointerId)return;
      pointer.x=event.clientX;pointer.y=event.clientY;
      if(!pointer.dragging){
        if(Math.hypot(pointer.x-pointer.initialX,pointer.y-pointer.initialY)>10){suppressClick=true;release();}
        return;
      }
      event.preventDefault();onTarget(targetAt());
    },
    up(event){
      if(!pointer||pointer.pointerId!==event.pointerId)return;
      pointer.x=event.clientX;pointer.y=event.clientY;
      if(pointer.dragging){event.preventDefault();onDrop(targetAt(),pointer.id);}
      release();
    },
    cancel(){release();},
    consumeClick(){const result=suppressClick;suppressClick=false;return result;}
  };
}
