import { z } from 'zod';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
const time = z.string().regex(/^\d{2}:\d{2}$/).refine(v=>{const [hour,minute]=v.split(':').map(Number);return hour<24&&minute<60;});
const instant = z.iso.datetime({offset:true});
export const entrySchema = z.object({
  id:z.uuid(), kind:z.enum(['note','task','event']), body:z.string().trim().min(1).max(50000),
  title:z.string().trim().max(200).default(''), tags:z.array(z.string().trim().min(1).max(30)).max(12).default([]),
  status:z.enum(['active','done','cancelled','archived']).default('active'), inbox:z.boolean().default(true),
  focusDate:date.nullable().default(null), scheduledDate:date.nullable().default(null), scheduledTime:time.nullable().default(null), durationMinutes:z.number().int().min(1).max(10080).nullable().default(null), dueDate:date.nullable().default(null), dueTime:time.nullable().default(null),
  startAt:instant.nullable().default(null), endAt:instant.nullable().default(null), startTime:time.nullable().default(null), endTime:time.nullable().default(null), allDay:z.boolean().default(false),
  reminderAt:instant.nullable().default(null), wechatReminder:z.boolean().default(false), sourceId:z.uuid().nullable().default(null), deletedAt:instant.nullable().default(null),
  captureMode:z.enum(['auto','note','task','event']).nullable().default(null),
  capturedAt:instant.nullable().default(null),
  originalBody:z.string().max(50000).nullable().default(null), aiSummary:z.string().max(500).default(''),
  quadrant:z.enum(['urgent-important','important','urgent','later']).nullable().default(null), phase:z.enum(['todo','doing']).default('todo')
}).strict().superRefine((v,ctx)=>{
  if(v.wechatReminder&&!v.reminderAt)ctx.addIssue({code:'custom',message:'请选择微信提醒时间',path:['reminderAt']});
  if(v.kind==='event'&&v.endAt&&(!v.startAt||Date.parse(v.endAt)<=Date.parse(v.startAt)))ctx.addIssue({code:'custom',message:'日程结束时间必须晚于开始时间',path:['endAt']});
  if(v.kind!=='event'&&(v.startAt||v.endAt||v.allDay))ctx.addIssue({code:'custom',message:'仅日程使用起止时间',path:['startAt']});
  if(v.kind!=='task'&&(v.scheduledTime||v.dueTime))ctx.addIssue({code:'custom',message:'仅待办使用计划和截止时间',path:['scheduledTime']});
  if(v.kind==='note'&&v.durationMinutes)ctx.addIssue({code:'custom',message:'仅待办和日程使用持续时长',path:['durationMinutes']});
  if(v.kind!=='event'&&(v.startTime||v.endTime))ctx.addIssue({code:'custom',message:'仅日程使用开始和结束时间',path:['startTime']});
  if(v.kind==='note'&&(v.focusDate||v.scheduledDate||v.dueDate))ctx.addIssue({code:'custom',message:'请先将记录关联为待办再安排执行日期',path:['kind']});
});
export const mutationSchema=z.object({operationId:z.uuid(),baseVersion:z.number().int().min(0),entry:entrySchema}).strict();
export const importSchema=z.object({format:z.literal('joybeat-me'),schemaVersion:z.literal(1),exportedAt:z.string(),entries:z.array(z.object({entry:entrySchema,createdAt:instant})).max(10000)}).strict();
export const subscriptionSchema=z.object({endpoint:z.url().max(2048),expirationTime:z.number().nullable().optional(),keys:z.object({p256dh:z.string().regex(/^[A-Za-z0-9_-]{80,200}$/),auth:z.string().regex(/^[A-Za-z0-9_-]{16,100}$/)}).strict()}).strict();
