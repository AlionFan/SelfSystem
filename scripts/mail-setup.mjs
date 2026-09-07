import http from 'node:http';
import {readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const styles=`body{margin:0;background:#f7f8f2;color:#304336;font:15px/1.8 -apple-system,sans-serif}main{max-width:480px;margin:7vh auto;padding:36px;background:#fffdf8;border:1px solid #dfe6d9;border-radius:16px}h1{font-family:Georgia,serif;font-size:30px}label{display:block;margin:18px 0;font-size:13px}input,select,button{box-sizing:border-box;width:100%;padding:13px;border-radius:8px;border:1px solid #dce3d6;font-size:16px;margin-top:7px}button{background:#476b50;color:white;border:0;cursor:pointer}button:disabled{opacity:.6}p{font-size:13px;color:#667460}a{color:#3b6846}small{font-size:12px}.error{color:#9a352c}.success{padding:14px;background:#edf5e9;border-radius:8px}[hidden]{display:none!important}@media(max-width:600px){main{margin:15px;padding:24px}}`;
const clientScript=`const form=document.querySelector('form');
form.addEventListener('submit',async event=>{
 event.preventDefault();const button=form.querySelector('button'),notice=document.querySelector('#notice');button.disabled=true;button.textContent='正在保存…';notice.textContent='';
 try{
  const values=Object.fromEntries(new FormData(form));
  const response=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'保存未完成，请重试');
  form.elements.password.value='';form.hidden=true;document.querySelector('#success').hidden=false;document.querySelector('#saved-email').textContent=result.sender;
 }catch(error){notice.className='error';notice.textContent=error.message==='Failed to fetch'?'暂时无法连接本机设置服务。填写内容仍保留，请稍后重试。':error.message;}
 finally{button.disabled=false;button.textContent='保存发信设置';}
});`;

export function createMailSetup({configPath,port=5190,onSaved=()=>{}}){
  const token=randomBytes(32).toString('base64url');
  const page=(body,nonce,script=false)=>`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Me · 发信设置</title><style nonce="${nonce}">${styles}</style>${script?'<script src="/form.js" defer></script>':''}</head><body><main>${body}</main></body></html>`;
  const server=http.createServer(async(req,res)=>{
    const effectivePort=port||server.address().port,origin=`http://127.0.0.1:${effectivePort}`,nonce=randomBytes(16).toString('base64url');
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');res.setHeader('X-Content-Type-Options','nosniff');
    // Native navigation POSTs can send Origin:null under no-referrer. Use fetch
    // so validation errors never replace the form with a browser error page.
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    res.setHeader('Content-Type','text/html;charset=utf-8');
    const json=(status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json;charset=utf-8');res.end(JSON.stringify(value));};
    if(req.headers.host!==`127.0.0.1:${effectivePort}`)return json(403,{error:'请使用本机 127.0.0.1 地址打开设置页。'});
    try{
      if(req.method==='GET'&&req.url==='/form.js'){res.setHeader('Content-Type','text/javascript;charset=utf-8');return res.end(clientScript);}
      if(req.method==='GET'&&['/','/save'].includes(req.url)){
        const config=JSON.parse(readFileSync(configPath,'utf8')),sender=config.smtp?.user??'',gmail=config.smtp?.host==='smtp.gmail.com';
        return res.end(page(`<h1>Me · 连接发信邮箱</h1><p>此页面只在当前电脑运行。授权码保存在本机受保护配置中，随后用于你的服务器发送验证码。</p>${req.url==='/save'?'<p class="error">上次提交页面未正常显示。请在下方重新保存，保存成功后会出现明确提示。</p>':''}${sender?`<p>当前已保存发信邮箱：${escape(sender)}。如需修改，请重新填写授权码。</p>`:''}<p id="notice" role="alert" aria-live="polite"></p><form method="POST" action="/save"><input type="hidden" name="csrf" value="${token}"><label>发信服务<select name="provider"><option value="qq" ${gmail?'':'selected'}>QQ 邮箱（北京服务器已测可连接）</option><option value="gmail" ${gmail?'selected':''}>Gmail（当前北京连接超时）</option></select></label><label>发信邮箱<input type="email" name="email" value="${escape(sender)}" autocomplete="username" required maxlength="254" placeholder="你的 QQ 邮箱地址"></label><label>邮箱 SMTP 授权码<input type="password" name="password" autocomplete="off" required minlength="10" maxlength="128" placeholder="粘贴邮箱生成的授权码"></label><p>请使用邮箱设置中生成的 SMTP 专用授权码，不是日常邮箱登录密码。授权码不用发送到聊天里。</p><button>保存发信设置</button><noscript><p class="error">请启用 JavaScript 后保存。</p></noscript></form><section id="success" class="success" hidden role="status"><h2>已保存。</h2><p>发信邮箱：<strong id="saved-email"></strong></p><p>授权码没有发送到聊天。请回复“已保存”，我会继续验证发信并完成网站切换。</p></section><small>主账号仍为 1210604006@cnu.edu.cn。</small>`,nonce,true));
      }
      if(req.method==='POST'&&req.url==='/save'){
        if(!req.headers['content-type']?.startsWith('application/json'))return res.end(page('<h1>请重新打开设置页</h1><p>此表单已更新，请返回新版设置页后填写。设置尚未保存。</p><a href="/">打开新版设置页</a>',nonce));
        if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return json(403,{error:'提交来源未通过验证，请重新打开设置页后重试。'});
        let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>4096)return json(413,{error:'填写内容过长，请检查后重试。'});body+=chunk;}
        let fields;try{fields=JSON.parse(body);}catch{return json(400,{error:'提交内容格式不正确，请重试。'});}
        const proof=Buffer.from(typeof fields?.csrf==='string'?fields.csrf:'');
        if(proof.length!==token.length||!timingSafeEqual(proof,Buffer.from(token)))return json(403,{error:'设置页已经过期，请重新打开设置页后填写。'});
        const parsed=z.object({email:z.email().max(254),password:z.string().min(10).max(128),provider:z.enum(['qq','gmail']),csrf:z.string()}).strict().safeParse(fields);
        if(!parsed.success)return json(400,{error:'邮箱或授权码格式不正确，请检查后重试。'});
        const {provider}=parsed.data,email=parsed.data.email.trim().toLowerCase(),password=parsed.data.password.replace(/\s/g,'');
        if(password.length<10)return json(400,{error:'授权码过短，请填写完整的 SMTP 专用授权码。'});
        const config=JSON.parse(readFileSync(configPath,'utf8'));
        config.smtp={host:provider==='qq'?'smtp.qq.com':'smtp.gmail.com',port:465,secure:true,user:email,password,from:`Me <${email}>`};
        const temporary=configPath+'.tmp';writeFileSync(temporary,JSON.stringify(config,null,2),{mode:0o600});chmodSync(temporary,0o600);renameSync(temporary,configPath);
        onSaved();return json(200,{ok:true,sender:email});
      }
      res.statusCode=404;res.end(page('<h1>页面不存在</h1><a href="/">返回发信设置</a>',nonce));
    }catch{return json(500,{error:'本机保存未完成，填写内容仍保留，请重试。'});}
  });
  return server;
}
