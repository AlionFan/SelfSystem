import {openStore} from '../server/store.mjs';
import {backup} from 'node:sqlite';
import {mkdirSync,writeFileSync,chmodSync} from 'node:fs';
import path from 'node:path';
const directory=process.env.BACKUP_DIR??path.join(process.env.DATA_DIR??'data','backups');mkdirSync(directory,{recursive:true,mode:0o700});
const store=openStore(process.env.DATA_DIR??'data'),stamp=new Date().toISOString().replace(/[:.]/g,'-'),base=path.join(directory,`me-${stamp}`);
try{await backup(store.db,`${base}.sqlite`);chmodSync(`${base}.sqlite`,0o600);writeFileSync(`${base}.json`,JSON.stringify(store.exportAllData()),{mode:0o600});store.db.prepare("INSERT INTO meta(key,value) VALUES ('lastBackup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({at:new Date().toISOString(),file:path.basename(base)}));console.log(path.basename(base));}finally{store.close();}
