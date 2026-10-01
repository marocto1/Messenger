import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const data=mkdtempSync(path.join(tmpdir(),'messenger-ui-'));
const child=spawn(process.execPath,['server/index.js'],{stdio:'inherit',env:{...process.env,PORT:'14382',DATA_DIR:data,ALLOWED_ORIGIN:'http://localhost:3000',WEBAUTHN_ORIGINS:'http://localhost:3000',WEBAUTHN_RP_ID:'localhost',TRUST_PROXY:'true'}});
const cleanup=()=>{child.kill('SIGTERM');setTimeout(()=>{rmSync(data,{recursive:true,force:true});process.exit(0)},1000).unref()};
process.on('SIGTERM',cleanup);process.on('SIGINT',cleanup);child.on('exit',code=>{rmSync(data,{recursive:true,force:true});process.exit(code||0)});
