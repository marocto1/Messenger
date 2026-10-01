import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { root as projectRoot } from './runtime.mjs';
const root=path.join(projectRoot,'apps/web/out');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json','.txt':'text/plain','.woff2':'font/woff2'};
http.createServer((req,res)=>{
 let pathname; try { pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname); } catch { res.writeHead(400).end(); return; } let file=path.resolve(root,'.'+pathname);
 if(!file.startsWith(root+path.sep)&&file!==root){res.writeHead(403).end();return;}
 if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
 if(!fs.existsSync(file)&&fs.existsSync(file+'.html'))file+='.html';
 if(!fs.existsSync(file)){res.writeHead(404).end();return;}
 res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Content-Security-Policy',"frame-ancestors 'none'");
 res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.WEB_PORT || 3000),process.env.WEB_HOST || '127.0.0.1',()=>console.log(`Web export: http://localhost:${process.env.WEB_PORT || 3000}`));
