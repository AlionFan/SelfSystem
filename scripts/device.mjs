import {readFileSync} from 'node:fs';
import {X509Certificate,randomUUID} from 'node:crypto';
import {openStore} from '../server/store.mjs';
const [action,...args]=process.argv.slice(2);const store=openStore(process.env.DATA_DIR??'data');
try{
  if(action==='register'){
    const [file,name]=args;if(!file||!name)throw new Error('Usage: register certificate.pem device-name');
    const cert=new X509Certificate(readFileSync(file));
    if(!cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2'))throw new Error('Client authentication certificate required');
    store.db.prepare('INSERT INTO devices(id,name,fingerprint,created_at,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET name=excluded.name,expires_at=excluded.expires_at').run(randomUUID(),name,cert.fingerprint256,new Date().toISOString(),new Date(cert.validTo).toISOString());
    console.log('Device registered:',name);
  }else if(action==='revoke'){
    const row=store.db.prepare('SELECT id FROM devices WHERE id=? OR fingerprint=?').get(args[0],args[0]);if(!row)throw new Error('Device not found');
    store.db.prepare('UPDATE devices SET active=0 WHERE id=?').run(row.id);store.db.prepare('DELETE FROM subscriptions WHERE device_id=?').run(row.id);console.log('Device revoked');
  }else if(action==='list')console.log(JSON.stringify(store.db.prepare('SELECT id,name,active,expires_at AS expiresAt FROM devices').all(),null,2));
  else throw new Error('Usage: node scripts/device.mjs register|revoke|list');
}finally{store.close();}
