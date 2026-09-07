import http from 'node:http';
import {mkdirSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';

export function normalizeApiKey(value){
  if(typeof value!=='string')throw new Error('请粘贴百炼控制台复制的完整 API Key。');
  let key=value.trim();
  // Treat the credential as opaque: prefixes, encodings and lengths can change.
  if((key.startsWith('"')&&key.endsWith('"'))||(key.startsWith("'")&&key.endsWith("'")))key=key.slice(1,-1).trim();
  key=key.replace(/^Bearer\s+/i,'');
  if(!key)throw new Error('请粘贴百炼控制台复制的完整 API Key。');
  if(/[*＊…]|\.{3,}/.test(key))throw new Error('这看起来是隐藏部分字符的密钥。请使用控制台的复制按钮获取完整值。');
  if(/\s/.test(key))throw new Error('密钥中包含空格或换行，请只复制 API Key 本身。');
  if(!/^[\x21-\x7e]+$/.test(key)||/["'`]/.test(key))throw new Error('密钥中包含异常字符，请从百炼控制台重新复制，不要手动输入。');
  if(key.length<16||key.length>4096)throw new Error('密钥长度异常，请使用百炼控制台的复制按钮获取完整值。');
  return key;
}

export function createAiSetup({configPath,port=5191,onSaved=()=>{}}){
  const token=randomBytes(32).toString('base64url');
  const script=`document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button'),n=document.querySelector('#notice');b.disabled=true;try{const r=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});const d=await r.json();if(!r.ok)throw Error(d.error);f.reset();f.hidden=true;n.textContent='已保存。密钥只保存在本机受保护文件中，我会继续将其配置到你的服务器。';}catch(x){n.textContent=x.message;}finally{b.disabled=false;}});`;
  const server=http.createServer(async(req,res)=>{
    const effectivePort=port||server.address().port,origin=`http://127.0.0.1:${effectivePort}`,nonce=randomBytes(16).toString('base64url');
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify(value));};
    if(req.headers.host!==`127.0.0.1:${effectivePort}`)return json(403,{error:'请使用本机地址打开。'});
    if(req.method==='GET'&&req.url==='/form.js'){res.writeHead(200,{'Content-Type':'text/javascript;charset=utf-8'});return res.end(script);}
    if(req.method==='GET'&&req.url==='/'){
      res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Me · 连接 Qwen-Flash</title><style nonce="${nonce}">body{background:#f6f7f0;color:#304336;font:15px/1.8 system-ui;margin:0}main{max-width:480px;margin:8vh auto;background:#fffefa;border:1px solid #dce5d5;border-radius:12px;padding:30px}h1{font-size:24px}p{font-size:14px;color:#66785e}input,button{box-sizing:border-box;width:100%;padding:14px;font-size:16px;border:1px solid #d7e2cf;border-radius:7px;margin:12px 0}button{background:#476b50;color:white;cursor:pointer}a{color:#476b50}label{font-size:14px}[hidden]{display:none}@media(max-width:600px){main{margin:20px 12px}}</style><script src="/form.js" defer></script><main><h1>连接 Qwen-Flash</h1><p>请使用百炼中国大陆（北京）地域的通用 API Key，并通过控制台的复制按钮获取完整值。密钥不需要发到聊天里。</p><p><a href="https://help.aliyun.com/zh/model-studio/get-api-key" target="_blank" rel="noreferrer">查看如何获取 API Key</a></p><form><input type="hidden" name="csrf" value="${token}"><label>百炼 API Key<input type="password" name="apiKey" autocomplete="off" placeholder="粘贴完整 API Key" required autocapitalize="none" spellcheck="false"></label><p>仅配置 qwen-flash。初始额度：每账号每天 100 次、全站每月预算 20 元；可在服务器配置中调整。</p><button>保存并用于 Me 网站</button></form><p id="notice" role="status" aria-live="polite"></p></main></html>`);
    }
    if(req.method!=='POST'||req.url!=='/save')return json(404,{error:'页面不存在。'});
    if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'来源验证失败，请重新打开设置页。'});
    try{
      let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)return json(413,{error:'填写内容过长，请只粘贴完整 API Key。'});body+=chunk;}
      let fields;try{fields=JSON.parse(body);}catch{return json(400,{error:'数据格式无效。'});}
      const proof=Buffer.from(typeof fields?.csrf==='string'?fields.csrf:'');
      if(proof.length!==token.length||!timingSafeEqual(proof,Buffer.from(token)))return json(403,{error:'设置页已过期，请重新打开。'});
      let key;try{key=normalizeApiKey(fields.apiKey);}catch(error){return json(400,{error:error.message});}
      mkdirSync(path.dirname(configPath),{recursive:true,mode:0o700});const tmp=configPath+'.tmp';
      writeFileSync(tmp,JSON.stringify({enabled:true,model:'qwen-flash',apiKey:key,perUserDailyLimit:100,globalDailyLimit:2000,monthlyBudgetYuan:20},null,2),{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,configPath);onSaved();return json(200,{ok:true});
    }catch{return json(500,{error:'本机保存未完成，请重试。'});}
  });
  return server;
}
