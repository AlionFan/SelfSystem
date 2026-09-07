import { spawn } from 'node:child_process';
import { mkdirSync,existsSync,writeFileSync } from 'node:fs';
import {randomBytes} from 'node:crypto';
mkdirSync('.local/dev',{recursive:true});
const accountFile=process.env.ACCOUNT_CONFIG_FILE??'.local/dev/account.json';
if(!existsSync(accountFile))writeFileSync(accountFile,JSON.stringify({secret:randomBytes(32).toString('base64url'),ownerEmail:'owner@example.test',registration:'open',wechatProvider:'pushplus',smtp:null}),{mode:0o600});
const children = [
  spawn(process.execPath,['server/index.mjs'],{stdio:'inherit',env:{...process.env,NODE_ENV:'development',AUTH_MODE:'account',ACCOUNT_CONFIG_FILE:accountFile,HOST:'127.0.0.1',PORT:'3100',APP_ORIGIN:'http://127.0.0.1:5173',DATA_DIR:'.local/dev'}}),
  spawn(process.execPath,['node_modules/vite/bin/vite.js'],{stdio:'inherit'})
];
function stop(){for(const child of children)child.kill();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
for(const child of children)child.on('exit',stop);
