import { X509Certificate, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

function equals(a,b){const x=Buffer.from(a??''),y=Buffer.from(b??'');return x.length===y.length&&timingSafeEqual(x,y);}
export function createAuth({store,mode,caFile,proxySecret,csrfSecret,origin}){
  if(mode==='local-dev'&&process.env.NODE_ENV==='production')throw new Error('Local authentication is forbidden in production');
  if(!['local-dev','proxy-mtls'].includes(mode))throw new Error('An explicit authentication mode is required');
  const ca=mode==='proxy-mtls'?new X509Certificate(readFileSync(caFile)):null;
  if(mode==='proxy-mtls'&&(!proxySecret||proxySecret.length<32))throw new Error('Proxy secret is required');
  const csrf=id=>createHmac('sha256',csrfSecret).update(id).digest('base64url');
  if(mode==='local-dev')store.db.prepare('INSERT OR IGNORE INTO devices(id,name,fingerprint,created_at,expires_at) VALUES (?,?,?,?,?)').run('local-preview','本机预览','local-preview',new Date().toISOString(),'2099-01-01T00:00:00Z');
  function authenticate(req,res,next){
    try{
      let fingerprint;
      if(mode==='local-dev'){
        if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return res.status(403).send('Forbidden');
        fingerprint='local-preview';
      }else{
        if(!equals(req.get('x-me-proxy-secret'),proxySecret))return res.status(403).send('此设备未获授权');
        const raw=req.get('x-forwarded-tls-client-cert');
        if(!raw||raw.length>16000)return res.status(403).send('此设备未获授权');
        const decoded=decodeURIComponent(raw).replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g,'');
        const cert=new X509Certificate(Buffer.from(decoded,'base64'));
        if(!cert.checkIssued(ca)||!cert.verify(ca.publicKey)||Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now()||!cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2'))return res.status(403).send('设备证书无效或已到期');
        fingerprint=cert.fingerprint256;
      }
      const device=store.db.prepare('SELECT id,name,active,expires_at,last_seen FROM devices WHERE fingerprint=?').get(fingerprint);
      if(!device?.active||Date.parse(device.expires_at)<=Date.now())return res.status(403).send('设备授权已失效');
      req.device=device;
      if(!device.last_seen||Date.now()-Date.parse(device.last_seen)>60000)store.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(new Date().toISOString(),device.id);
      next();
    }catch{return res.status(403).send('无法验证此设备');}
  }
  function protectMutation(req,res,next){
    if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
    if(req.get('origin')!==origin||req.get('sec-fetch-site')==='cross-site'||!equals(req.get('x-me-csrf'),csrf(req.device.id)))return res.status(403).json({error:'请求验证失败，请刷新后重试'});
    if(!req.is('application/json'))return res.status(415).json({error:'请使用 JSON 格式'});
    next();
  }
  return {authenticate,protectMutation,csrf};
}
