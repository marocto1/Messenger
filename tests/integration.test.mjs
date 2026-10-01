import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-v1-test-'));
const port = 14381; const base = `http://127.0.0.1:${port}`;
let server, db, alice, brian, chris, direct, group, channel, msg, attachment;
async function api(route, user, body, method = body === undefined ? 'GET' : 'POST', status = 200, headers = {}) {
 const res = await fetch(base + route, { method, headers: { ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
 const data = res.status === 204 ? null : await res.json();
 assert.equal(res.status, status, `${method} ${route}: ${JSON.stringify(data)}`); return data;
}
before(async () => {
 execFileSync(process.execPath, ['tests/legacy-schema.mjs', path.join(dir,'messenger.db')], { cwd: root });
 db = new Database(path.join(dir,'messenger.db')); db.pragma('foreign_keys = ON');
 const salt = 'legacySalt'; const key = crypto.scryptSync('LegacyPassword123', salt, 64).toString('base64');
 db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run('legacy-user','legacy_user','Legacy User',`scrypt$${Buffer.from(salt).toString('base64')}$${key}`,'2026-09-01T00:00:00.000Z');
 server=spawn(process.execPath,['server/index.js'],{cwd:root, env:{...process.env,PORT:String(port),DATA_DIR:dir,NODE_ENV:'test',SECURITY_MASTER_KEY:'test-only-fixed-master-key-not-for-production'}});
 let output='';server.stderr.on('data', b=>{output+=b});
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return;}catch{} await new Promise(r=>setTimeout(r,50));}
 throw new Error('Server did not start: '+output);
});
after(async()=>{if(server){server.kill('SIGTERM');await once(server,'exit');}db?.close();fs.rmSync(dir,{recursive:true,force:true});});
test('v0.14 migration, legacy login, FK integrity, second initialization',async()=>{
 await api('/auth/login',null,{username:'legacy_user',password:'LegacyPassword123'});
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n,1);
 assert.equal(db.prepare('SELECT display_name FROM users WHERE id=?').get('legacy-user').display_name,'Legacy User');
});
test('registration, hashed sessions, authentication, origin checks and PUT preflight',async()=>{
 alice=await api('/auth/register',null,{username:'alice_test',displayName:'Alice Morgan',password:'Password12345'},'POST',201);
 brian=await api('/auth/register',null,{username:'brian_test',displayName:'Brian Miller',password:'Password12345'},'POST',201);
 chris=await api('/auth/register',null,{username:'chris_test',displayName:'Chris Brooks',password:'Password12345'},'POST',201);
 assert.notEqual(db.prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(alice.user.id).token_hash,alice.token);
 await api('/me',null,undefined,'GET',401);
 await api('/me',alice,undefined,'GET',403,{Origin:'https://evil.example'});
 const pre=await fetch(base+'/uploads/id/chunks/0',{method:'OPTIONS',headers:{Origin:'http://localhost:3000','Access-Control-Request-Method':'PUT'}});
 assert.equal(pre.status,204);assert.match(pre.headers.get('access-control-allow-methods'),/PUT/);
 assert.equal((await api('/me',alice)).user.username,'alice_test');
 const bad=await fetch(base+'/auth/login',{method:'POST',body:'null'});assert.equal(bad.status,400);
});
test('direct messages, exact idempotency, reply, edit, receipt privacy, reaction, forward, deletion',async()=>{
 direct=(await api('/conversations/direct',alice,{username:'brian_test'})).conversation;
 msg=(await api(`/conversations/${direct.id}/messages`,alice,{body:'Hello @brian_test',clientRequestId:'one'},'POST',201)).message;
 assert.equal((await api(`/conversations/${direct.id}/messages`,alice,{body:'Hello',clientRequestId:'one'})).message.id,msg.id);
 await api(`/messages/${msg.id}`,chris,undefined,'GET',404);
 await api(`/messages/${msg.id}`,brian,{body:'wrong'},'PATCH',403);
 const reply=(await api(`/conversations/${direct.id}/messages`,brian,{body:'Reply',replyToId:msg.id},'POST',201)).message;assert.equal(reply.replyTo.id,msg.id);
 await api(`/messages/${msg.id}`,alice,{body:'Edited @brian_test'},'PATCH');
 const reacted=await api(`/messages/${msg.id}/reactions`,brian,{emoji:'❤️'});assert.equal(reacted.message.reactions[0].count,1);
 await api('/privacy',brian,{readReceipts:false},'PATCH');await api(`/conversations/${direct.id}/read`,brian,{},'POST',204);
 assert.equal((await api(`/messages/${msg.id}`,alice)).message.readByOther,false);
 const saved=(await api('/conversations',alice)).conversations.find(c=>c.isSaved);
 const f=(await api(`/messages/${msg.id}/forward`,alice,{conversationId:saved.id},'POST',201)).message;assert.equal(f.forwardedFrom.id,msg.id);
 await api(`/conversations/${saved.id}/messages`,alice,{body:'Collision',clientRequestId:'one'},'POST',409);
 assert.equal((await api(`/messages/${reply.id}`,brian,undefined,'DELETE')).message.deletedAt!==null,true);
});
test('groups, roles, invite, state, folders, blocked users, reports, mentions and activity',async()=>{
 group=(await api('/conversations/group',alice,{title:'Planning',usernames:['brian_test']},'POST',201)).conversation;
 await api(`/conversations/${group.id}`,brian,{title:'No'},'PATCH',403);
 await api(`/conversations/${group.id}/members/${brian.user.id}`,alice,{role:'admin'},'PATCH');
 await api(`/conversations/${group.id}`,brian,{title:'Shared Plan'},'PATCH');
 const inv=(await api(`/conversations/${group.id}/invite`,alice,{},'POST',201)).invite;
 await api(`/invites/${inv.token}/join`,chris,{});
 await api(`/conversations/${group.id}/invite`,alice,undefined,'DELETE',204);
 await api(`/invites/${inv.token}/join`,chris,{},'POST',404);
 await api(`/conversations/${group.id}/messages`,alice,{body:'Hey @brian_test'},'POST',201);
 assert.ok((await api('/activity',brian)).activities.some(a=>a.type==='mention'));
 await api('/activity/read',brian,{},'POST',204);
 const folder=(await api('/folders',alice,{name:'Work'},'POST',201)).folder;
 await api(`/folders/${folder.id}/chats/${group.id}`,alice,undefined,'PUT',204);
 await api(`/conversations/${group.id}/state`,alice,{archived:true,pinned:true},'PATCH');
 assert.ok((await api('/folders',alice)).folders[0].conversationIds.includes(group.id));
 await api('/users/brian_test/block',alice,{}); await api(`/conversations/${direct.id}/messages`,brian,{body:'blocked'},'POST',403);
 await api('/users/brian_test/block',alice,undefined,'DELETE');
 await api('/reports',alice,{reason:'spam',conversationId:direct.id,messageId:msg.id,targetUserId:brian.user.id},'POST',201);
});
test('channels, subscriber cannot publish, channel comments, pinning and search',async()=>{
 channel=(await api('/channels',alice,{title:'News',username:'test_news'},'POST',201)).conversation;
 await api('/channels/test_news/join',brian,{});
 const post=(await api(`/conversations/${channel.id}/messages`,alice,{body:'Release https://example.com'},'POST',201)).message;
 await api(`/conversations/${channel.id}/messages`,brian,{body:'cannot'},'POST',403);
 await api(`/channels/${channel.id}/posts/${post.id}/comments`,brian,{body:'Congratulations'},'POST',201);
 assert.equal((await api(`/channels/${channel.id}/posts/${post.id}/comments`,alice)).comments.length,1);
 await api(`/conversations/${channel.id}/pin`,alice,{messageId:post.id});
 assert.ok((await api('/search?q=Release',alice)).messages.length);
 assert.equal((await api(`/conversations/${channel.id}/links`,alice)).links.length,1);
});
test('uploads: resumable, ownership, missing chunks, completion retry, MIME safety, scoped tickets and range',async()=>{
 const contents=Buffer.from('<html><script>alert(1)</script>');
 const up=(await api('/uploads/init',alice,{fileName:'../../test.svg',mimeType:'image/svg+xml',size:contents.length},'POST',201)).upload;
 await api(`/uploads/${up.id}/status`,brian,undefined,'GET',404);
 await api(`/uploads/${up.id}/complete`,alice,{},'POST',409);
 const chunk=await fetch(base+`/uploads/${up.id}/chunks/0`,{method:'PUT',headers:{Authorization:`Bearer ${alice.token}`},body:contents});assert.equal(chunk.status,200);
 assert.deepEqual((await api(`/uploads/${up.id}/status`,alice)).upload.receivedChunks,[0]);
 attachment=(await api(`/uploads/${up.id}/complete`,alice,{},'POST',201)).media;
 assert.equal(attachment.mimeType,'application/octet-stream');
 const albumMessage=(await api(`/conversations/${direct.id}/messages`,alice,{attachmentId:attachment.id,albumId:'release_album'},'POST',201)).message;assert.equal(albumMessage.albumId,'release_album');
 assert.ok((await api('/search?q=test.svg',alice)).messages.some(m=>m.attachment?.id===attachment.id));
 assert.equal((await api(`/uploads/${up.id}/complete`,alice,{})).media.id,attachment.id);
 await api('/me',alice,{avatarMediaId:attachment.id},'PATCH',400);
 const m=(await api(`/conversations/${direct.id}/messages`,alice,{attachmentId:attachment.id},'POST',201)).message;assert.equal(m.attachment.id,attachment.id);
 const ticket=await api(`/media/${attachment.id}/access`,brian);
 const ranged=await fetch(base+ticket.path,{headers:{Range:'bytes=0-5'}});assert.equal(ranged.status,206);assert.equal((await ranged.arrayBuffer()).byteLength,6);assert.match(ranged.headers.get('content-disposition'),/^attachment/);
 await api(`/media/${attachment.id}/access`,chris,undefined,'GET',404);
});
test('stable timestamp ties in message/gallery pagination, no omissions or overlap',async()=>{
 const conv=(await api('/conversations',alice)).conversations.find(c=>c.isSaved); const at='2026-09-15T12:00:00.000Z';
 const insert=db.prepare('INSERT INTO messages(id,conversation_id,sender_id,body,created_at,attachment_id) VALUES (?,?,?,?,?,?)');
 for(let i=0;i<120;i++)insert.run(`page-${String(i).padStart(3,'0')}`,conv.id,alice.user.id,'Pagination',at,attachment.id);
 let cursor='',seen=[];
 do {const page=await api(`/conversations/${conv.id}/messages?limit=25${cursor?'&before='+cursor:''}`,alice);seen.push(...page.messages.map(m=>m.id));cursor=page.nextCursor;}while(cursor);
 assert.equal(new Set(seen).size,121);assert.equal(seen.length,121);
 let mediaSeen=[],mc='';do {const page=await api(`/conversations/${conv.id}/media?limit=25${mc?'&before='+mc:''}`,alice);mediaSeen.push(...page.items.map(m=>m.messageId));mc=page.nextCursor;}while(mc);
 assert.equal(new Set(mediaSeen).size,120);assert.equal(mediaSeen.length,120);
});
test('draft authorization, sync cursor, scheduled date validation, scheduled send and export',async()=>{
 await api(`/drafts/${direct.id}`,alice,{body:'draft'},'PUT');assert.equal((await api('/drafts',alice)).drafts[0].body,'draft');
 await api(`/drafts/${direct.id}`,chris,{body:'no'},'PUT',403);
 const foreign=(await api('/conversations',chris)).conversations.find(c=>c.isSaved);
 const m=(await api(`/conversations/${foreign.id}/messages`,chris,{body:'secret'},'POST',201)).message;
 await api(`/drafts/${direct.id}`,alice,{body:'wrong reply',replyToId:m.id},'PUT',400);
 const sync=await api('/sync?after=0&limit=10',alice);assert.ok(sync.cursor>0);assert.ok(sync.events.length);
 const item=(await api('/scheduled',alice,{conversationId:direct.id,body:'Scheduled hello',sendAt:new Date(Date.now()+60000).toISOString()},'POST',201)).scheduled;
 await api(`/scheduled/${item.id}`,alice,{sendAt:'invalid'},'PATCH',400);
 db.prepare('UPDATE scheduled_messages SET send_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),item.id);
 for(let i=0;i<120;i++){if(db.prepare('SELECT status FROM scheduled_messages WHERE id=?').get(item.id).status==='sent')break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(db.prepare('SELECT status FROM scheduled_messages WHERE id=?').get(item.id).status,'sent');
 const exported=await api('/me/export',alice);assert.ok(exported.messages);assert.equal(JSON.stringify(exported).includes('password_hash'),false);
});
test('Bot API tokens, SSRF protection, mini app URL policy and token rotation',async()=>{
 const bot=await api('/bots',alice,{username:'release_helper_bot',displayName:'Release Bot'},'POST',201);
 const botUser={token:bot.token};await api('/botapi/getMe',botUser);
 for(const url of ['http://localhost:4000','https://127.0.0.1','https://[::1]','file:///etc/passwd'])await api('/botapi/setWebhook',botUser,{url},'POST',400);
 await api('/botapi/setMiniApp',botUser,{url:'https://example.com/app'});
 const chat=(await api('/bots/release_helper_bot/start',alice,{})).conversation;
 await api('/botapi/sendMessage',botUser,{chatId:chat.id,text:'Bot message'},'POST',201);
 await api(`/bots/${bot.bot.id}/rotate-token`,brian,{},'POST',404);
 const rotated=await api(`/bots/${bot.bot.id}/rotate-token`,alice,{});assert.notEqual(rotated.token,bot.token);
 await api('/botapi/getMe',botUser,undefined,'GET',401);
});
function totp(secret) { let bits=0,value=0,bytes=[];for(const c of secret){value=(value<<5)|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const d=crypto.createHmac('sha1',Buffer.from(bytes)).update(counter).digest();const o=d[d.length-1]&15;return ((d.readUInt32BE(o)&0x7fffffff)%1000000).toString().padStart(6,'0');}
test('2FA enable, TOTP replay blocked, recovery codes single use, passkey challenge rejection',async()=>{
 const setup=await api('/security/2fa/setup',alice,{});const confirm=await api('/security/2fa/confirm',alice,{setupId:setup.setupId,code:totp(setup.secret)});assert.equal(confirm.recoveryCodes.length,10);
 await api('/security/2fa/setup',alice,{},'POST',409);
 const challenge=await api('/auth/login',null,{username:'alice_test',password:'Password12345'},'POST',202);
 await api('/auth/2fa/verify',null,{challengeId:challenge.challengeId,code:totp(setup.secret)});
 const again=await api('/auth/login',null,{username:'alice_test',password:'Password12345'},'POST',202);
 await api('/auth/2fa/verify',null,{challengeId:again.challengeId,code:totp(setup.secret)},'POST',401);
 await api('/security/2fa/disable',alice,{code:confirm.recoveryCodes[0]});
 const options=await api('/security/passkeys/options',alice);assert.equal(options.options.authenticatorSelection.userVerification,'required');
 await api('/security/passkeys/verify',alice,{challengeId:options.challengeId,response:{}},'POST',400);
});
async function connect(user){const ws=new WebSocket(`ws://127.0.0.1:${port}/ws?token=${user.token}`,{origin:'http://localhost:3000'});await once(ws,'open');return ws;}
async function waitFor(ws, type, action){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.off('message',on);reject(new Error('No socket event '+type));},3000);function on(raw){const event=JSON.parse(raw);if(event.type===type){clearTimeout(timer);ws.off('message',on);resolve(event);}}ws.on('message',on);action();});}
test('WebSocket real messaging, typing, call signaling, voice/video rooms and logout revocation',async()=>{
 const a=await connect(alice),b=await connect(brian);
 const event=await waitFor(b,'typing',()=>a.send(JSON.stringify({type:'typing',conversationId:direct.id,active:true})));assert.equal(event.userId,alice.user.id);
 const incoming=await waitFor(b,'call:incoming',()=>a.send(JSON.stringify({type:'call:start',conversationId:direct.id,mode:'video'})));
 const accepted=waitFor(a,'call:accepted',()=>b.send(JSON.stringify({type:'call:accept',callId:incoming.call.id})));await accepted;
 await waitFor(b,'call:offer',()=>a.send(JSON.stringify({type:'call:offer',callId:incoming.call.id,sdp:{type:'offer',sdp:'test'}})));
 await waitFor(b,'call:ended',()=>a.send(JSON.stringify({type:'call:end',callId:incoming.call.id})));
 const room=await waitFor(a,'room:joined',()=>a.send(JSON.stringify({type:'room:join',conversationId:group.id,mode:'video'})));
 await waitFor(b,'room:joined',()=>b.send(JSON.stringify({type:'room:join',conversationId:group.id,mode:'video'})));
 await waitFor(b,'room:offer',()=>a.send(JSON.stringify({type:'room:offer',roomId:room.room.id,targetUserId:brian.user.id,sdp:{type:'offer',sdp:'test'}})));
 a.send(JSON.stringify({type:'room:leave',roomId:room.room.id}));b.send(JSON.stringify({type:'room:leave',roomId:room.room.id}));
 const closed=once(b,'close');await api('/auth/logout',brian,{},'POST',204);assert.equal((await closed)[0],4001);a.close();
});
test('online backup, live restore guard, checksums and isolated restore without stale WAL',async()=>{
 const backups=path.join(dir,'backups'); const env={...process.env,DATA_DIR:dir,BACKUP_DIR:backups};
 execFileSync(process.execPath,['scripts/backup.mjs'],{cwd:root,env});
 const backup=path.join(backups,fs.readdirSync(backups)[0]); const restoreEnv={...env,CONFIRM_RESTORE:'YES'};
 assert.throws(()=>execFileSync(process.execPath,['scripts/restore.mjs',backup],{cwd:root,env:restoreEnv,stdio:'pipe'}),/Command failed/);
 const restored=path.join(dir,'restored'); fs.mkdirSync(restored);fs.writeFileSync(path.join(restored,'messenger.db-wal'),'old WAL bytes');
 execFileSync(process.execPath,['scripts/restore.mjs',backup],{cwd:root,env:{...restoreEnv,DATA_DIR:restored}});
 assert.equal(fs.existsSync(path.join(restored,'messenger.db-wal')),false);
 const copy=new Database(path.join(restored,'messenger.db')); assert.equal(copy.pragma('integrity_check',{simple:true}),'ok');assert.equal(copy.prepare('SELECT COUNT(*) n FROM messages').get().n,db.prepare('SELECT COUNT(*) n FROM messages').get().n);copy.close();
 fs.appendFileSync(path.join(backup,'messenger.db'),'tampered');
 assert.throws(()=>execFileSync(process.execPath,['scripts/restore.mjs',backup],{cwd:root,env:{...restoreEnv,DATA_DIR:path.join(dir,'bad-restore')},stdio:'pipe'}),/Command failed/);
});
test('final data integrity and migration idempotency',async()=>{
 assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
 const count=db.prepare('SELECT COUNT(*) n FROM messages').get().n;
 server.kill('SIGTERM');await once(server,'exit');
 server=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:dir,NODE_ENV:'test'}});
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
 assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,count);assert.deepEqual(db.pragma('foreign_key_check'),[]);
});

test('registration throttling rejects forged proxy headers unless TRUST_PROXY is explicit',async()=>{
 for(let i=0;i<8;i++)await api('/auth/register',null,{username:`limit_${i}`,displayName:'Limit User',password:'Password12345'},'POST',201);
 const response=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'198.51.100.123'},body:JSON.stringify({username:'limit_over',displayName:'Limit User',password:'Password12345'})});
 assert.equal(response.status,429);assert.ok(response.headers.get('Retry-After'));
});
