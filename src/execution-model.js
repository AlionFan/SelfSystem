const normalized=text=>text.trim().replace(/\s+/g,' ').toLowerCase();
export function appendPlanSteps(existing,suggestions,makeId=()=>crypto.randomUUID()){
 const keys=new Set(existing.map(i=>normalized(i.text))),items=[...existing];
 for(const s of suggestions){const key=normalized(s.text);if(!key||keys.has(key))continue;keys.add(key);items.push({id:makeId(),text:s.text.trim(),required:!!s.required});}
 if(items.length>40)throw new Error('检查清单最多 40 项，请减少建议或整理已有步骤');return items;
}
export function taskQuality(content,assignment){
 const issues=[];if(assignment&&!assignment.assigneeId)issues.push('还没有负责人');
 if(!content.dueDate&&!content.scheduledDate&&!content.startAt)issues.push('尚未安排时间');
 if(assignment?.reviewRequired&&!content.acceptanceCriteria?.trim())issues.push('需要验收，但还没有验收标准');
 if(content.body?.trim().length<8)issues.push('描述较短，可以补充预期结果');return issues;
}
