import express from 'express';
import {z} from 'zod';
export function organizationRouter({org,auth,orgAi,voice,orgNotifications}){
 const router=express.Router();
 router.get('/',(req,res)=>res.json({organizations:org.list(req.user.id)}));
 router.post('/',(req,res)=>{auth.limit(`org-create:${req.user.id}`,10,3600000);res.status(201).json(org.create(req.user.id,req.body));});
 router.post('/join',(req,res)=>{auth.limit(`org-join:${req.user.id}`,20,3600000);res.json(org.join(req.user.id,req.body));});
 router.get('/mine',(req,res)=>{const tasks=[];for(const o of org.list(req.user.id)){if(o.state!=='active')continue;const c=org.context(req.user.id,o.id);tasks.push(...org.listTasks(c).filter(t=>t.status!=='draft'&&(t.assigneeId===req.user.id||t.creatorId===req.user.id||t.collaboratorIds.includes(req.user.id)||t.status==='review'&&t.permissions.review||t.preference.focusDate)).map(t=>({...t,organizationName:o.name})));}res.json({tasks});});
 router.use('/:orgId',(req,_res,next)=>{z.uuid().parse(req.params.orgId);req.org=org.context(req.user.id,req.params.orgId,{paused:true});if(req.org.org.state!=='active'&&!['GET'].includes(req.method)&&!req.path.endsWith('/settings')&&!req.path.endsWith('/transfer'))throw Object.assign(new Error('组织已暂停，请先恢复'),{status:403});next();});
 router.get('/:orgId',(req,res)=>res.json(org.home(req.org)));
 router.get('/:orgId/library',(req,res)=>res.json(org.productivity.library(req.org)));
 router.get('/:orgId/work-drafts/:id',(req,res)=>res.json(org.productivity.draft(req.org,req.params.id)));
 router.get('/:orgId/tasks',(req,res)=>res.json({tasks:org.listTasks(req.org,req.query)}));
 router.get('/:orgId/tasks/:id',(req,res)=>res.json(org.detail(req.org,req.params.id)));
 router.get('/:orgId/shares',(req,res)=>res.json({shares:org.shares(req.org)}));
 router.get('/:orgId/notifications',(req,res)=>res.json({notifications:orgNotifications.list(req.org)}));
 router.get('/:orgId/export',(req,res)=>res.attachment(`me-organization-${req.org.orgId}.json`).json(org.exportData(req.org)));
 router.get('/:orgId/invitations',(req,res)=>{if(!req.org.admin)return res.json({invitations:[]});res.json({invitations:org.db.prepare('SELECT id,email,role,state,expires_at AS expiresAt,mail_state AS mailState FROM org_invitations WHERE org_id=? ORDER BY created_at DESC LIMIT 100').all(req.org.orgId)});});
 router.get('/:orgId/invitations/:id/link',(req,res)=>res.json({url:org.invitationLink(req.org,req.params.id)}));
 router.get('/:orgId/audit',(req,res)=>{if(!req.org.admin)return res.status(403).json({error:'需要组织管理员权限'});res.json({events:org.db.prepare('SELECT actor_id AS actorId,action,detail,created_at AS createdAt FROM org_audit WHERE org_id=? ORDER BY created_at DESC LIMIT 100').all(req.org.orgId).map(r=>({...r,detail:JSON.parse(r.detail)}))});});
 router.post('/:orgId/ai',async(req,res)=>{auth.limit(`org-ai:${req.user.id}`,10,60000);res.json(await orgAi.preview(req.org,req.body));});
 router.get('/:orgId/voice',(req,res)=>{orgAi.voiceContext(req.org);res.json(voice.status(req.user.id));});
 router.get('/:orgId/voice/jobs/:id',(req,res)=>res.json(voice.result(req.user.id,req.params.id,orgAi.voiceContext(req.org))));
 router.post('/:orgId/voice/transcribe',async(req,res)=>{res.json(await voice.transcribe(req.user.id,req.body,orgAi.voiceContext(req.org)));});
 router.post('/:orgId/actions/:action',(req,res)=>{auth.limit(`org-mutate:${req.user.id}`,100,60000);res.json(org.mutate(req.org,req.body,req.params.action));});
 return router;
}
