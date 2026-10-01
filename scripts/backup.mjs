import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { root, loadEnvFile } from './runtime.mjs';
loadEnvFile(path.join(root, 'server', '.env'));
const data = path.resolve(process.env.DATA_DIR || path.join(root,'server','data'));
const dbPath = path.join(data,'messenger.db');
if (!fs.existsSync(dbPath)) throw new Error('Database not found. Set DATA_DIR if using a custom location.');
const target = path.resolve(process.env.BACKUP_DIR || path.join(root,'backups'), new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(target,{recursive:true});
const db=new Database(dbPath,{readonly:true});
try { await db.backup(path.join(target,'messenger.db')); } finally { db.close(); }
if(fs.existsSync(path.join(data,'uploads'))) fs.cpSync(path.join(data,'uploads'),path.join(target,'uploads'),{recursive:true});
function hashes(dir,prefix='') {
 const result={}; for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
  const name=path.posix.join(prefix,entry.name); const file=path.join(dir,entry.name);
  if(entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in backup.');
  if(entry.isDirectory()) Object.assign(result,hashes(file,name));
  else if(entry.isFile()) result[name]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 } return result;
}
fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify({version:'1.0.0',createdAt:new Date().toISOString(),files:hashes(target)},null,2));
console.log(`Backup created: ${target}`);
