import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createMailSetup} from '../scripts/mail-setup.mjs';

test('mail setup saves same-origin JSON atomically and rejects null origin or stale forms without modifying secrets',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'me-mail-form-')),configPath=path.join(dir,'config.json'),original={secret:'test-only-preserved-secret',ownerEmail:'owner@example.test',smtp:null};
  writeFileSync(configPath,JSON.stringify(original),{mode:0o600});
  const server=createMailSetup({configPath,port:0});server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,page=await fetch(base),html=await page.text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  assert.equal(page.headers.get('referrer-policy'),'same-origin');assert.match(html,/src="\/form.js"/);
  const fields={csrf,email:'fixture@example.test',password:'test-only-smtp-fixture',provider:'qq'};
  async function post(body=fields,origin=base){const r=await fetch(base+'/save',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
  assert.equal((await post(fields,'null')).status,403);assert.equal((await post(fields,'https://other.test')).status,403);assert.equal((await post({...fields,csrf:'stale'})).status,403);
  assert.deepEqual(JSON.parse(readFileSync(configPath)),original);
  const saved=await post();assert.equal(saved.status,200);assert.deepEqual(saved.body,{ok:true,sender:fields.email});
  const config=JSON.parse(readFileSync(configPath));assert.equal(config.secret,original.secret);assert.equal(config.smtp.password,fields.password);assert.equal(statSync(configPath).mode&0o777,0o600);
  const native=await fetch(base+'/save',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'csrf=stale'});assert.equal(native.status,200);assert.match(await native.text(),/打开新版设置页/);
  assert.equal((await fetch(base+'/save')).status,200);
});
