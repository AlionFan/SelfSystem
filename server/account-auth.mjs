import express from 'express';
import {randomBytes,randomInt,randomUUID,createHash,createHmac,timingSafeEqual,scrypt as scryptCallback} from 'node:crypto';
import {promisify} from 'node:util';
import {z} from 'zod';
import nodemailer from 'nodemailer';
import {entrySchema} from './schema.mjs';

const scrypt=promisify(scryptCallback),emailSchema=z.email().max(254).transform(v=>v.toLowerCase()),passwordSchema=z.string().min(10,'密码至少 10 个字符').max(128,'密码最多 128 个字符');
const digest=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(a??''),y=Buffer.from(b??'');return x.length===y.length&&timingSafeEqual(x,y);};
let passwordQueue=Promise.resolve(),passwordWaiting=0;
async function derive(password,salt){
  if(passwordWaiting>=5)throw Object.assign(new Error('登录请求较多，请稍后再试'),{status:429});
  passwordWaiting++;const previous=passwordQueue;let release;passwordQueue=new Promise(resolve=>release=resolve);await previous;
  try{return await scrypt(password,salt,32,{N:131072,r:8,p:1,maxmem:192*1024*1024});}finally{passwordWaiting--;release();}
}
export async function hashPassword(password){const salt=randomBytes(16).toString('base64url');return `scrypt-v1:${salt}:${(await derive(password,salt)).toString('base64url')}`;}
export async function checkPassword(password,encoded){const [,salt,expected]=(encoded??'scrypt-v1:account-does-not-exist:invalid').split(':');const actual=await derive(password,salt);return equal(actual.toString('base64url'),expected);}

export function initializeOwner(store,config){
  const {db}=store;db.exec('BEGIN IMMEDIATE');
  try{
    let owner=db.prepare("SELECT id,email FROM users WHERE role='owner'").get();
    if(!owner){const id=randomUUID();db.prepare('INSERT INTO users(id,email,role,created_at) VALUES (?,?,?,?)').run(id,config.ownerEmail?emailSchema.parse(config.ownerEmail):null,'owner',new Date().toISOString());owner={id};}
    if(!db.prepare("SELECT 1 FROM meta WHERE key='accountsMigrated'").get()){
      for(const row of db.prepare('SELECT id,response FROM operations WHERE user_id IS NULL').all()){
        const response=JSON.parse(row.response);if(response.entry){const {version,createdAt,updatedAt,...entry}=response.entry;const normalized={operationId:row.id,baseVersion:version-1,entry:entrySchema.parse(entry)};db.prepare('UPDATE operations SET request_hash=? WHERE id=?').run(digest(JSON.stringify(normalized)),row.id);}
      }
      for(const table of ['entries','operations','devices'])db.prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`).run(owner.id);
      db.prepare("UPDATE devices SET active=0 WHERE fingerprint NOT LIKE 'session:%'").run();
      db.prepare("INSERT INTO meta(key,value) VALUES ('accountsMigrated',?)").run(JSON.stringify(new Date().toISOString()));
    }
    if(config.ownerInviteHash){const user=db.prepare('SELECT password_hash FROM users WHERE id=?').get(owner.id);if(!user.password_hash)db.prepare('INSERT OR IGNORE INTO invitations(code_hash,email,owner_id,expires_at,created_at) VALUES (?,?,?,?,?)').run(config.ownerInviteHash,config.ownerEmail?emailSchema.parse(config.ownerEmail):null,owner.id,new Date(Date.now()+30*86400000).toISOString(),new Date().toISOString());}
    db.exec('COMMIT');return owner.id;
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export function createAccountAuth({store,config,origin,secure=true,sendMailOverride,now=()=>Date.now()}){
  if(!config?.secret||Buffer.from(config.secret,'base64url').length<32)throw new Error('Account secret is required');
  if(!secure&&process.env.NODE_ENV==='production')throw new Error('Secure cookies are required in production');
  const db=store.db,router=express.Router(),cookieName=secure?'__Host-me-session':'me-dev-session',ttl=30*86400000;
  const transporter=config.smtp?.host&&config.smtp?.from?nodemailer.createTransport({host:config.smtp.host,port:config.smtp.port??465,secure:config.smtp.secure!==false,requireTLS:true,auth:config.smtp.user?{user:config.smtp.user,pass:config.smtp.password}:undefined,tls:{rejectUnauthorized:true},connectionTimeout:10000,socketTimeout:15000,logger:false,debug:false}):null;
  const mailConfigured=Boolean(transporter||sendMailOverride);
  const sign=value=>createHmac('sha256',config.secret).update(value).digest('base64url');
  const userView=user=>({id:user.id,email:user.email,role:user.role,emailVerified:Boolean(user.verified_at)});
  function csrf(hash){return sign(`csrf:${hash}`);}
  function lookup(req){
    const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if(!cookie||!/^[A-Za-z0-9_-]{43}$/.test(cookie))return null;
    const hash=digest(cookie),row=db.prepare('SELECT s.token_hash,s.user_id,s.device_id,s.expires_at,u.email,u.role,u.verified_at,d.name FROM sessions s JOIN users u ON u.id=s.user_id JOIN devices d ON d.id=s.device_id WHERE s.token_hash=? AND s.expires_at>? AND d.active=1').get(hash,new Date(now()).toISOString());
    if(!row)return null;return {hash,user:{id:row.user_id,email:row.email,role:row.role,verified_at:row.verified_at},device:{id:row.device_id,name:row.name,expires_at:row.expires_at}};
  }
  function attach(req,session){req.user=session.user;req.device=session.device;req.accountSession=session;db.prepare('UPDATE devices SET last_seen=? WHERE id=? AND (last_seen IS NULL OR last_seen<?)').run(new Date(now()).toISOString(),req.device.id,new Date(now()-60000).toISOString());}
  function authenticate(req,res,next){const session=lookup(req);if(!session)return res.status(401).json({error:'请先登录'});attach(req,session);next();}
  function checkOrigin(req,res,next){if(!['GET','HEAD','OPTIONS'].includes(req.method)&&(req.get('origin')!==origin||req.get('sec-fetch-site')==='cross-site'||!req.is('application/json')))return res.status(403).json({error:'请求来源验证失败，请刷新后重试'});next();}
  function protectMutation(req,res,next){return checkOrigin(req,res,()=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!equal(req.get('x-me-csrf'),csrf(req.accountSession.hash)))return res.status(403).json({error:'登录状态已更新，请刷新后重试'});next();});}
  function ip(req){return req.get('x-forwarded-for')?.split(',').at(-1)?.trim()||req.socket.remoteAddress||'unknown';}
  function limit(key,max,window){const stamp=now(),hashed=sign(`limit:${key}`),row=db.prepare('SELECT count,until_at FROM auth_limits WHERE key=?').get(hashed);if(row&&row.until_at>stamp&&row.count>=max)throw Object.assign(new Error('尝试次数较多，请稍后再试'),{status:429});db.prepare('INSERT INTO auth_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,until_at=excluded.until_at').run(hashed,row&&row.until_at>stamp?row.count+1:1,row&&row.until_at>stamp?row.until_at:stamp+window);db.prepare('DELETE FROM auth_limits WHERE until_at<?').run(stamp-86400000);}
  function inviteFor(code,email){if(!code)return null;const invitation=db.prepare('SELECT * FROM invitations WHERE code_hash=? AND used_at IS NULL AND expires_at>?').get(digest(code),new Date(now()).toISOString());return invitation&&(!invitation.email||invitation.email===email)?invitation:null;}
  function nameFor(req){const ua=req.get('user-agent')??'';return /Android/i.test(ua)?'安卓手机':/iPhone|iPad/i.test(ua)?'iPhone / iPad':/Windows/i.test(ua)?'Windows':/Macintosh|Mac OS/i.test(ua)?'MacBook':/Linux/i.test(ua)?'Ubuntu / Linux':'网页浏览器';}
  function clearCookie(res){res.clearCookie(cookieName,{httpOnly:true,secure,sameSite:'lax',path:'/'});}
  function startSession(req,res,user){
    const token=randomBytes(32).toString('base64url'),hash=digest(token),id=randomUUID(),stamp=new Date(now()).toISOString(),expiry=new Date(now()+ttl).toISOString();
    db.prepare('INSERT INTO devices(id,name,fingerprint,created_at,last_seen,expires_at,user_id) VALUES (?,?,?,?,?,?,?)').run(id,nameFor(req),'session:'+id,stamp,stamp,expiry,user.id);
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(hash,user.id,id,expiry,stamp);
    res.cookie(cookieName,token,{httpOnly:true,secure,sameSite:'lax',path:'/',maxAge:ttl});
    return {authenticated:true,user:userView(user),device:{id,name:nameFor(req),expiresAt:expiry},csrf:csrf(hash)};
  }
  function revokeSessions(userId){db.prepare('UPDATE devices SET active=0 WHERE user_id=?').run(userId);db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);db.prepare('DELETE FROM subscriptions WHERE device_id IN (SELECT id FROM devices WHERE user_id=?)').run(userId);}
  async function sendCode(email,purpose){
    const code=String(randomInt(100000,1000000)),stamp=new Date(now()+10*60000).toISOString();
    db.prepare('INSERT INTO email_codes VALUES (?,?,?,?,0) ON CONFLICT(email,purpose) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0').run(email,purpose,sign(`${email}:${purpose}:${code}`),stamp);
    try{const message={from:config.smtp?.from,to:email,subject:purpose==='reset'?'Me · 重设密码验证码':'Me · 邮箱验证码',text:`你的 Me 验证码是 ${code}，10 分钟内有效。\n\n如果不是你本人操作，请忽略此邮件。\n${origin}`};if(sendMailOverride)await sendMailOverride({...message,code,purpose});else await transporter.sendMail(message);}catch{db.prepare('DELETE FROM email_codes WHERE email=? AND purpose=?').run(email,purpose);throw Object.assign(new Error('邮件暂未发出，请稍后重试'),{status:502});}
  }
  function validCode(email,purpose,code){const row=db.prepare('SELECT * FROM email_codes WHERE email=? AND purpose=?').get(email,purpose);if(!row||row.attempts>=5||Date.parse(row.expires_at)<=now())return false;db.prepare('UPDATE email_codes SET attempts=attempts+1 WHERE email=? AND purpose=?').run(email,purpose);return equal(row.code_hash,sign(`${email}:${purpose}:${code}`));}
  function consumeCode(email,purpose,code){const row=db.prepare('SELECT * FROM email_codes WHERE email=? AND purpose=?').get(email,purpose);if(!row||row.attempts>5||Date.parse(row.expires_at)<=now()||!equal(row.code_hash,sign(`${email}:${purpose}:${code}`)))throw Object.assign(new Error('验证码已使用或已过期'),{status:400});db.prepare('DELETE FROM email_codes WHERE email=? AND purpose=?').run(email,purpose);}
  router.use(checkOrigin,express.json({limit:'12kb'}));
  router.get('/status',(req,res)=>{const session=lookup(req);res.json({authenticated:Boolean(session),...(session?{user:userView(session.user),csrf:csrf(session.hash)}:{}),mailConfigured,registration:config.registration??'invite'});});
  router.post('/login',async(req,res)=>{
    const {email,password}=z.object({email:emailSchema,password:z.string().max(128)}).strict().parse(req.body);limit(`login-ip:${ip(req)}`,12,5*60000);limit(`login-email:${email}`,12,15*60000);
    const user=db.prepare('SELECT * FROM users WHERE email=?').get(email),valid=await checkPassword(password,user?.password_hash);
    if(!valid||!user?.password_hash)return res.status(401).json({error:'邮箱或密码不正确'});
    db.prepare('DELETE FROM auth_limits WHERE key=?').run(sign(`limit:login-email:${email}`));res.json(startSession(req,res,user));
  });
  router.post('/email-code',async(req,res)=>{
    const {email,purpose,inviteCode}=z.object({email:emailSchema,purpose:z.enum(['register','reset','verify']),inviteCode:z.string().max(128).optional()}).strict().parse(req.body);
    if(!mailConfigured)return res.status(503).json({error:'验证码发送服务正在准备中，请稍后再试。'});
    limit(`mail-ip:${ip(req)}`,10,3600000);limit(`mail-email:${email}`,1,60000);limit(`mail-day:${email}`,10,86400000);
    const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(purpose==='register'&&config.registration!=='open'&&!inviteFor(inviteCode,email))return res.status(400).json({error:'请输入有效的邀请码'});
    if(purpose==='verify'){const session=lookup(req);if(!session||session.user.email!==email)return res.status(401).json({error:'请先登录此邮箱对应的账号'});}
    if(purpose==='register'&&user?.password_hash||purpose==='reset'&&!user?.password_hash)return res.json({ok:true,message:'如该邮箱可以进行此操作，验证码将会送达。'});
    limit('mail-global-day',config.smtp?.dailyLimit??100,86400000);
    await sendCode(email,purpose);res.json({ok:true,message:'如该邮箱可以进行此操作，验证码将会送达。'});
  });
  router.post('/register',async(req,res)=>{
    const {email,password,code,inviteCode}=z.object({email:emailSchema,password:passwordSchema,code:z.string().max(12).optional(),inviteCode:z.string().max(128).optional()}).strict().parse(req.body);
    if(!mailConfigured)return res.status(503).json({error:'验证码发送服务正在准备中，请稍后注册'});
    limit(`register:${ip(req)}`,8,3600000);const invitation=inviteFor(inviteCode,email);
    if((config.registration!=='open'||!mailConfigured)&&!invitation)return res.status(400).json({error:'请输入有效的邀请码'});
    if(mailConfigured&&!validCode(email,'register',code))return res.status(400).json({error:'验证码不正确、已过期或尝试次数过多'});
    const passwordHash=await hashPassword(password);db.exec('BEGIN IMMEDIATE');
    let user;
    try{
      if(invitation&&!inviteFor(inviteCode,email))throw new Error('邀请码已失效');
      const existing=db.prepare('SELECT * FROM users WHERE email=?').get(email);
      const ownerId=invitation?.owner_id??(existing?.role==='owner'&&config.ownerEmail?.toLowerCase()===email?existing.id:null);
      if(existing?.password_hash||existing&&existing.id!==ownerId)throw new Error('无法使用此邮箱注册，请尝试登录或找回密码');
      consumeCode(email,'register',code);
      const id=ownerId??randomUUID(),verified=new Date(now()).toISOString();
      if(ownerId){const target=db.prepare('SELECT password_hash FROM users WHERE id=?').get(id);if(!target||target.password_hash)throw new Error('主账号已经激活');db.prepare('UPDATE users SET email=?,password_hash=?,verified_at=? WHERE id=?').run(email,passwordHash,verified,id);}
      else db.prepare('INSERT INTO users(id,email,password_hash,verified_at,created_at) VALUES (?,?,?,?,?)').run(id,email,passwordHash,verified,new Date(now()).toISOString());
      if(invitation)db.prepare('UPDATE invitations SET used_at=? WHERE code_hash=?').run(new Date(now()).toISOString(),invitation.code_hash);
      db.prepare('DELETE FROM email_codes WHERE email=? AND purpose=?').run(email,'register');user=db.prepare('SELECT * FROM users WHERE id=?').get(id);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');return res.status(400).json({error:error.message});}
    res.status(201).json(startSession(req,res,user));
  });
  router.post('/reset-password',async(req,res)=>{
    const {email,password,code}=z.object({email:emailSchema,password:passwordSchema,code:z.string().max(12)}).strict().parse(req.body);limit(`reset:${ip(req)}`,10,3600000);
    if(!mailConfigured)return res.status(503).json({error:'密码找回尚未启用，请联系管理员'});
    if(!validCode(email,'reset',code))return res.status(400).json({error:'验证码不正确或已过期'});
    const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!user?.password_hash)return res.status(400).json({error:'无法重设此账号'});
    const passwordHash=await hashPassword(password);db.exec('BEGIN IMMEDIATE');try{consumeCode(email,'reset',code);db.prepare('UPDATE users SET password_hash=?,verified_at=? WHERE id=?').run(passwordHash,new Date(now()).toISOString(),user.id);revokeSessions(user.id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    clearCookie(res);res.json({ok:true,message:'密码已更新，请重新登录'});
  });
  router.post('/verify-email',authenticate,protectMutation,(req,res)=>{const {code}=z.object({code:z.string().max(12)}).strict().parse(req.body);if(!validCode(req.user.email,'verify',code))return res.status(400).json({error:'验证码不正确或已过期'});db.prepare('UPDATE users SET verified_at=? WHERE id=?').run(new Date(now()).toISOString(),req.user.id);db.prepare("DELETE FROM email_codes WHERE email=? AND purpose='verify'").run(req.user.email);res.json({ok:true});});
  router.post('/logout',authenticate,protectMutation,(req,res)=>{db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.accountSession.hash);db.prepare('UPDATE devices SET active=0 WHERE id=?').run(req.device.id);db.prepare('DELETE FROM subscriptions WHERE device_id=?').run(req.device.id);clearCookie(res);res.json({ok:true});});
  router.post('/change-password',authenticate,protectMutation,async(req,res)=>{const {currentPassword,password}=z.object({currentPassword:z.string().max(128),password:passwordSchema}).strict().parse(req.body);limit(`password:${req.user.id}`,6,15*60000);const user=db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);if(!await checkPassword(currentPassword,user.password_hash))return res.status(400).json({error:'当前密码不正确'});const hash=await hashPassword(password);db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,req.user.id);revokeSessions(req.user.id);clearCookie(res);res.json({ok:true,message:'密码已修改，请重新登录'});});
  router.post('/invitations',authenticate,protectMutation,(req,res)=>{if(req.user.role!=='owner')return res.status(403).json({error:'仅管理员可以邀请用户'});const {email}=z.object({email:emailSchema.optional()}).strict().parse(req.body);limit(`invite:${req.user.id}`,20,86400000);const code=randomBytes(24).toString('base64url'),expiresAt=new Date(now()+7*86400000).toISOString();db.prepare('INSERT INTO invitations(code_hash,email,expires_at,created_by,created_at) VALUES (?,?,?,?,?)').run(digest(code),email??null,expiresAt,req.user.id,new Date(now()).toISOString());res.json({url:`${origin}/#invite=${code}`,expiresAt});});
  return {router,authenticate,protectMutation,csrf:req=>csrf(req.accountSession.hash),userView,mailConfigured,limit,lookup};
}
