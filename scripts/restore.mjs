import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { root,loadEnvFile } from './runtime.mjs';
loadEnvFile(path.join(root,'server','.env'));
if(process.env.CONFIRM_RESTORE!=='YES') throw new Error('Stop the server and set CONFIRM_RESTORE=YES before restore.');
const source=process.argv[2]&&path.resolve(process.argv[2]);
const data=path.resolve(process.env.DATA_DIR || path.join(root,'server','data'));
if(!source||!fs.existsSync(path.join(source,'messenger.db'))) throw new Error('Usage: node scripts/restore.mjs <backup-folder>');
if(source===data||source.startsWith(data+path.sep)) throw new Error('Keep the backup outside the live data directory.');
const lock=path.join(data,'server.lock');
if(fs.existsSync(lock)) {
 const pid=Number(fs.readFileSync(lock,'utf8')); let alive=false;
 try { process.kill(pid,0);alive=true; } catch(error) { if(error.code!=='ESRCH') alive=true; }
 if(alive) throw new Error('Server is running. Stop it before restore.');
}
const db=new Database(path.join(source,'messenger.db'),{readonly:true});
try {
 if(db.pragma('integrity_check',{simple:true})!=='ok') throw new Error('Backup database integrity check failed.');
 if(db.pragma('foreign_key_check').length) throw new Error('Backup has broken foreign keys.');
 const files=db.prepare('SELECT storage_name FROM media').all();
 for(const row of files) {
  const file=path.basename(row.storage_name);
  if(file!==row.storage_name||fs.lstatSync(path.join(source,'uploads',file)).isSymbolicLink()) throw new Error('Unsafe media path in backup.');
  if(!fs.existsSync(path.join(source,'uploads',file))) throw new Error(`Backup is missing media: ${file}`);
 }
} finally {db.close();}
const manifest=path.join(source,'manifest.json');
if(fs.existsSync(manifest)) for(const [name,expected] of Object.entries(JSON.parse(fs.readFileSync(manifest,'utf8')).files||{})) {
 const file=path.resolve(source,name);
 if(!file.startsWith(source+path.sep)||!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid backup manifest path.');
 if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==expected) throw new Error(`Backup checksum failed: ${name}`);
}
const stage=`${data}.restore-${Date.now()}`;
fs.mkdirSync(stage,{recursive:true});
try {
 fs.copyFileSync(path.join(source,'messenger.db'),path.join(stage,'messenger.db'));
 if(fs.existsSync(path.join(source,'uploads'))) fs.cpSync(path.join(source,'uploads'),path.join(stage,'uploads'),{recursive:true});
 else fs.mkdirSync(path.join(stage,'uploads'));
 const previous=`${data}.before-restore-${Date.now()}`;
 if(fs.existsSync(data)) fs.renameSync(data,previous);
 try { fs.renameSync(stage,data); } catch(error) { if(fs.existsSync(previous)) fs.renameSync(previous,data); throw error; }
 console.log(`Restore complete. Previous data retained at ${previous}. Old WAL files were not reused.`);
} catch(error) {fs.rmSync(stage,{recursive:true,force:true});throw error;}
