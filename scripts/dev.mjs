import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(!existsSync(resolve(root,'apps/web/.env.development'))){console.error('Run pnpm setup:local first.');process.exit(1);}
const children=[spawn('pnpm',['--filter','@decision-arena/runner','dev'],{cwd:root,stdio:'inherit'}),spawn('pnpm',['--filter','@decision-arena/web','dev','--host','127.0.0.1','--port','5091'],{cwd:root,stdio:'inherit'})];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(code),500).unref();}
for(const child of children)child.on('exit',code=>stop(code??1));
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
