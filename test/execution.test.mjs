import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deliveryUrlSchema,checklistSchema} from '../server/organization-execution.mjs';
import {appendPlanSteps,taskQuality} from '../src/execution-model.js';
test('delivery links reject executable schemes, embedded credentials and malformed URLs',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,x','file:///etc/passwd','//example.test/a','https://user:pass@example.test','https://example.test/with space','https://example.test/\nsecret','http:example.test'])assert.equal(deliveryUrlSchema.safeParse(url).success,false,url);
 assert.equal(deliveryUrlSchema.parse('https://example.test/文档?a=1&b=2'),'https://example.test/文档?a=1&b=2');const step={id:randomUUID(),text:'核对',required:true};assert.equal(checklistSchema.safeParse([step,step]).success,false);assert.equal(checklistSchema.safeParse([{...step,completedAt:'2026-09-07'}]).success,false);
});
test('AI steps preserve manual definitions, deduplicate normalized text and bound expansion',()=>{
 const first={id:randomUUID(),text:'Review  Quote',required:false},result=appendPlanSteps([first],[{text:'review quote',required:true},{text:'核对税率',required:true}],randomUUID);assert.deepEqual(result[0],first);assert.equal(result.length,2);assert.notEqual(result[1].id,first.id);assert.throws(()=>appendPlanSteps(Array.from({length:40},(_,i)=>({id:randomUUID(),text:'步骤'+i,required:true})),[{text:'新的步骤',required:true}]),/40/);
 assert.equal(taskQuality({body:'明确交付内容和要求',dueDate:'2026-09-08',acceptanceCriteria:'核对金额'},{assigneeId:'member',reviewRequired:true}).length,0);assert.equal(taskQuality({body:'核对'},{reviewRequired:true}).length,4);
});
