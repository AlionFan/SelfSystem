import {mkdirSync,existsSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {randomBytes,createPrivateKey} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import webpush from 'web-push';
const dir=path.resolve('.local/access');mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
const run=args=>execFileSync('openssl',args,{stdio:['ignore','pipe','pipe']});
const file=(name,data)=>{writeFileSync(path.join(dir,name),data,{mode:0o600});chmodSync(path.join(dir,name),0o600);};
if(!existsSync(path.join(dir,'client-ca.pem'))){
  file('ca-password',randomBytes(32).toString('base64url'));
  run(['genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:3072','-aes-256-cbc','-pass',`file:${dir}/ca-password`,'-out',`${dir}/client-ca-key.pem`]);
  run(['req','-x509','-new','-sha256','-key',`${dir}/client-ca-key.pem`,'-passin',`file:${dir}/ca-password`,'-days','3650','-subj','/CN=Me Personal Device CA','-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign','-out',`${dir}/client-ca.pem`]);
}
file('client.ext','basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n');
const devices=[['macbook','MacBook'],['android','安卓手机'],['windows','Windows'],['ubuntu','Ubuntu']];
for(const [id,name] of devices){
  if(existsSync(`${dir}/${id}.p12`))continue;
  run(['genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',`${dir}/${id}.key`]);
  run(['req','-new','-key',`${dir}/${id}.key`,'-subj',`/CN=me-${id}`,'-out',`${dir}/${id}.csr`]);
  const signingKey=createPrivateKey({key:readFileSync(`${dir}/client-ca-key.pem`),passphrase:readFileSync(`${dir}/ca-password`,'utf8')}).export({type:'pkcs8',format:'pem'});
  execFileSync('openssl',['x509','-req','-in',`${dir}/${id}.csr`,'-CA',`${dir}/client-ca.pem`,'-CAkey','/dev/stdin','-set_serial',`0x${randomBytes(16).toString('hex')}`,'-days','365','-sha256','-extfile',`${dir}/client.ext`,'-out',`${dir}/${id}.pem`],{input:signingKey,stdio:'pipe'});
  file(`${id}.import-code`,randomBytes(12).toString('base64url'));
  run(['pkcs12','-export','-out',`${dir}/${id}.p12`,'-inkey',`${dir}/${id}.key`,'-in',`${dir}/${id}.pem`,'-certfile',`${dir}/client-ca.pem`,'-name',`Me - ${name}`,'-passout',`file:${dir}/${id}.import-code`]);
  for(const ext of ['key','p12','csr','pem'])chmodSync(`${dir}/${id}.${ext}`,0o600);
}
if(!existsSync(`${dir}/proxy-secret`))file('proxy-secret',randomBytes(48).toString('base64url'));
if(!existsSync(`${dir}/vapid.json`))file('vapid.json',JSON.stringify(webpush.generateVAPIDKeys()));
file('设备安装说明.md',`# Me 设备访问凭证\n\n网站：https://me.joybeat.cn\n\n每台设备只安装自己对应的 .p12 文件。下面的导入码仅用于安装凭证，无需设置或记忆网站密码。\n\n${devices.map(([id,name])=>`## ${name}\n\n凭证：[${id}.p12](${dir}/${id}.p12)\n\n导入码：\`${readFileSync(`${dir}/${id}.import-code`,'utf8')}\`\n`).join('\n')}\nMacBook：打开 .p12 文件，导入登录钥匙串，在浏览器访问网站时选择 Me - MacBook。\n\n安卓：在系统设置中安装 VPN 和应用用户证书，选择 android.p12；用支持客户端证书的浏览器访问网站并选择此证书。具体入口因系统而异。\n\nWindows：双击 windows.p12，导入当前用户的个人证书存储，在浏览器提示时选择 Me - Windows。\n\nUbuntu：在实际使用浏览器的证书管理页面中，导入 ubuntu.p12 到“您的证书”或“个人证书”。\n\n证书安装在不同浏览器/系统中的共享方式可能不同。不要导入其他设备的凭证。勿把本目录放入 Git、公共网盘或网站目录。\n\n丢失设备后，从另一台授权设备进入“设置与设备”撤销。全部设备都失效时，使用服务器 SSH 管理通道重新签发。签发密钥只保存在本机受保护目录，不部署到网页应用。\n`);
console.log('Access packages prepared for:',devices.map(d=>d[1]).join(', '));
