import {spawnSync} from 'node:child_process';
import {root,runtimeEnv} from './runtime.mjs';
const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['run','build:android'],{cwd:root,env:runtimeEnv({...process.env,ANDROID_BUILD_TYPE:'release'}),shell:process.platform==='win32',stdio:'inherit'});
process.exit(result.status||(result.error?1:0));
