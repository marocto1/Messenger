import { test, expect } from '@playwright/test';
const base='http://localhost:14382'; const password='release-test-password';
const unique=prefix=>`${prefix}_${Math.random().toString(36).slice(2,9)}`;
let accountIndex=0;
async function account(request,prefix='browser') { const response=await request.post(`${base}/auth/register`,{headers:{'X-Forwarded-For':`192.0.2.${++accountIndex}`},data:{username:unique(prefix),displayName:'Анна Смирнова',password}});expect(response.ok()).toBeTruthy();return response.json(); }
async function api(request,auth,path,method='GET',data) { const response=await request.fetch(base+path,{method,headers:{Authorization:`Bearer ${auth.token}`},data});expect(response.ok(),await response.text()).toBeTruthy();return response.status()===204?null:response.json(); }
async function open(page,auth) { await page.addInitScript(data=>{localStorage.setItem('messenger_token',data.token);localStorage.setItem('messenger_user',JSON.stringify(data.user))},auth);await page.goto('/');await expect(page.locator('.conversation').first()).toBeVisible(); }
async function saved(page) {await page.locator('.conversation').filter({hasText:'Saved Messages'}).click();await expect(page.getByRole('textbox',{name:'Сообщение',exact:true})).toBeVisible();}
async function send(page,body) {await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill(body);await page.getByRole('button',{name:'Отправить',exact:true}).click();await expect(page.locator('.messageRow .bubble').filter({hasText:body})).toHaveCount(1);}
test('registration, composer, replies, reactions, editing, deletion, modal keyboard',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/');await page.screenshot({path:'test-results/auth-desktop.png',fullPage:true});
 await page.getByLabel('Имя',{exact:true}).fill('Анна Смирнова');await page.getByLabel('Username',{exact:true}).fill(unique('ui'));await page.getByLabel('Пароль',{exact:true}).fill(password);await page.locator('form').getByRole('button',{name:'Создать аккаунт',exact:true}).click();
 await saved(page);await send(page,'Первое сообщение');
 const row=page.locator('.messageRow').filter({hasText:'Первое сообщение'}).first();
 await row.locator('.bubble').hover();await row.getByTitle('Ответить',{exact:true}).click();await send(page,'Ответ на первое');await expect(page.locator('.replyQuote')).toContainText('Первое сообщение');
 await row.locator('.bubble').hover();await row.getByTitle('Реакция',{exact:true}).click();await page.locator('.reactionPicker').getByRole('button',{name:'❤️',exact:true}).click();await expect(row.locator('.reactionRow')).toContainText('❤️');
 await row.locator('.bubble').hover();await row.getByTitle('Редактировать',{exact:true}).click();await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill('Исправленное сообщение\nВторая строка');await page.getByRole('button',{name:'Отправить',exact:true}).click();await expect(page.locator('.messageRow .bubble').filter({hasText:'Исправленное сообщение'})).toHaveCount(1);
 await page.locator('.messageRow').filter({hasText:'Исправленное сообщение'}).locator('.bubble').hover();await page.locator('.messageRow').filter({hasText:'Исправленное сообщение'}).getByTitle('Удалить',{exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.screenshot({path:'test-results/conversation-desktop.png',fullPage:true});expect(errors).toEqual([]);
});
test('offline outbox reconnect sends once and preserves a draft',async({page,context,request})=>{
 const auth=await account(request);await open(page,auth);await saved(page);
 await context.setOffline(true);await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill('Сообщение без сети');await page.getByRole('button',{name:'Отправить',exact:true}).click();await expect(page.locator('.pendingMessage')).toContainText('Сообщение без сети');
 await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill('Свежий локальный черновик');
 await context.setOffline(false);await expect(page.locator('.pendingMessage')).toHaveCount(0,{timeout:20000});await expect(page.locator('.messageRow .bubble').filter({hasText:'Сообщение без сети'})).toHaveCount(1);
 await expect(page.getByRole('textbox',{name:'Сообщение',exact:true})).toHaveValue('Свежий локальный черновик');
 const chats=await api(request,auth,'/conversations');const chat=chats.conversations.find(c=>c.isSaved);const data=await api(request,auth,`/conversations/${chat.id}/messages`);expect(data.messages.filter(m=>m.body==='Сообщение без сети')).toHaveLength(1);
});
test('themes, settings navigation, responsive layouts and focus trap',async({page,request})=>{
 const auth=await account(request);await open(page,auth);await saved(page);await send(page,'Встречаемся завтра в 10:30. Файлы и заметки будут здесь.');
 await page.getByTitle('Настройки',{exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Shift+Tab');expect(await page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement))).toBeTruthy();
 await page.getByRole('button',{name:'Оформление',exact:true}).click();await page.getByRole('button',{name:'Light',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(page.getByRole('button',{name:'Профиль',exact:true})).toHaveCSS('color','rgb(82, 103, 117)');await page.screenshot({path:'test-results/light-desktop.png',fullPage:true});await page.getByRole('button',{name:'Graphite',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','graphite');await expect(page.getByRole('button',{name:'Профиль',exact:true})).toHaveCSS('color','rgb(164, 175, 183)');await page.screenshot({path:'test-results/graphite-desktop.png',fullPage:true});await page.getByRole('button',{name:'Midnight',exact:true}).click();
 await page.screenshot({path:'test-results/settings-desktop.png',fullPage:true});await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('button',{name:'К списку чатов',exact:true})).toBeVisible();await expect(page.locator('body')).toHaveJSProperty('scrollWidth',390);await page.screenshot({path:'test-results/conversation-mobile.png',fullPage:true});await page.getByRole('button',{name:'К списку чатов',exact:true}).click();await expect(page.locator('.conversation').first()).toBeVisible();
});
test('resumable file upload, image viewer, gallery and attachment search',async({page,request})=>{
 const auth=await account(request);await open(page,auth);await saved(page);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=','base64');
 await page.locator('input[type=file]').setInputFiles({name:'release-photo.png',mimeType:'image/png',buffer:png});
 await expect(page.locator('.messageImage')).toBeVisible();await page.getByRole('button',{name:'Открыть release-photo.png',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
 await page.getByTitle('Медиа и файлы',{exact:true}).click();await expect(page.getByRole('dialog')).toContainText('release-photo.png');await page.keyboard.press('Escape');
 await page.getByTitle('Глобальный поиск',{exact:true}).click();await page.getByRole('textbox',{name:'Поиск по мессенджеру'}).fill('release-photo');await page.getByRole('button',{name:'Найти',exact:true}).click();await page.getByRole('tab',{name:'Медиа',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('release-photo.png');
});
test('passkey registration and passwordless login with virtual authenticator',async({page,context,request})=>{
 const auth=await account(request);const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 await open(page,auth);await page.getByTitle('Настройки',{exact:true}).click();await page.getByRole('button',{name:'Безопасность',exact:true}).click();await page.getByRole('button',{name:'＋ Passkey',exact:true}).click();
 await expect(page.getByRole('dialog').last()).toContainText('Название Passkey');await page.getByRole('dialog').last().getByRole('button',{name:'Продолжить',exact:true}).click();await expect(page.locator('.passkeyCard')).toHaveCount(1);await page.keyboard.press('Escape');
 await page.getByRole('navigation').getByTitle('Выйти',{exact:true}).click();await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByLabel('Username',{exact:true}).fill(auth.user.username);await page.getByRole('button',{name:'Войти с Passkey',exact:true}).click();await expect(page.locator('.conversation').first()).toBeVisible();
});
test('two browsers exchange real audio/video streams and clean up tracks',async({browser,request})=>{
 test.skip(process.env.SKIP_WEBRTC_MEDIA === 'true', 'Environment cannot gather ICE candidates / resolve STUN; run on a machine with WebRTC networking.');
 const a=await account(request,'caller');const b=await account(request,'callee');const direct=(await api(request,a,'/conversations/direct','POST',{username:b.user.username})).conversation;
 const ca=await browser.newContext({permissions:['microphone','camera']});const cb=await browser.newContext({permissions:['microphone','camera']});const pa=await ca.newPage();const pb=await cb.newPage();
 for(const page of [pa,pb]) await page.addInitScript(()=>{const Native=window.RTCPeerConnection;window.rtcConnections=[];window.RTCPeerConnection=class extends Native{constructor(config){super(config);window.rtcConnections.push(this);this.debugIce=[];this.addEventListener('icecandidate',event=>this.debugIce.push(event.candidate?.candidate));this.addEventListener('icecandidateerror',event=>this.debugIce.push(event.errorText))}}});
 try {
  await open(pa,a);await open(pb,b);await pa.locator('.conversation').filter({hasText:b.user.username}).click();await expect(pa.locator('.chatIdentity')).toBeVisible();await expect(pa.locator('.chatIdentity')).not.toContainText('переподключение');
  await pa.getByTitle('Видеозвонок',{exact:true}).click();await expect(pb.locator('.callOverlay')).toBeVisible();await pb.locator('.callAccept').click();await expect(pa.locator('.remoteVideo')).toBeVisible({timeout:20000});await expect(pb.locator('.remoteVideo')).toBeVisible({timeout:20000});
  console.log('RTC',await pa.evaluate(()=>window.rtcConnections?.map(pc=>({state:pc.connectionState,ice:pc.iceConnectionState,gather:pc.iceGatheringState,events:pc.debugIce,send:pc.getSenders().map(s=>s.track?.readyState),receive:pc.getReceivers().map(r=>r.track?.readyState)}))));await expect.poll(()=>pa.locator('.remoteVideo').evaluate(video=>video.readyState),{timeout:20000}).toBeGreaterThanOrEqual(2);await expect.poll(()=>pb.locator('.remoteVideo').evaluate(video=>video.readyState)).toBeGreaterThanOrEqual(2);
  await pa.getByTitle('Выключить микрофон',{exact:true}).click();await expect(pa.getByTitle('Включить микрофон',{exact:true})).toBeVisible();
  await pa.screenshot({path:'test-results/video-call.png',fullPage:true});await pa.getByTitle('Завершить',{exact:true}).click();await expect(pb.locator('.callOverlay')).toHaveCount(0);await expect(pa.locator('.callOverlay')).toHaveCount(0);
  expect((await api(request,a,'/calls/history')).calls[0].status).toBe('ended');
 } finally {await ca.close();await cb.close();}
});

test('call signaling, connecting state, mic control, media cleanup and two-person video room',async({browser,request})=>{
 const a=await account(request,'signal_a'),b=await account(request,'signal_b');await api(request,a,'/conversations/direct','POST',{username:b.user.username});
 const group=(await api(request,a,'/conversations/group','POST',{title:'Команда дизайна',usernames:[b.user.username]})).conversation;
 const ca=await browser.newContext({permissions:['microphone','camera']}),cb=await browser.newContext({permissions:['microphone','camera']});const pa=await ca.newPage(),pb=await cb.newPage();
 for(const page of [pa,pb]) await page.addInitScript(()=>{const Native=window.RTCPeerConnection;window.rtcConnections=[];window.RTCPeerConnection=class extends Native{constructor(config){super(config);window.rtcConnections.push(this)}}});
 try {
  await open(pa,a);await open(pb,b);await pa.locator('.conversation').filter({hasText:b.user.username}).click();
  await pa.getByTitle('Видеозвонок',{exact:true}).click();await pb.getByRole('button',{name:'Принять звонок'}).click();await expect(pa.locator('.remoteVideo')).toBeVisible();
  await expect.poll(()=>pa.evaluate(()=>window.rtcConnections[0]?.remoteDescription?.type)).toBe('answer');
  if(await pa.evaluate(()=>window.rtcConnections[0].connectionState!=='connected')) await expect(pa.locator('.callTop')).toContainText('Соединение');
  await pa.getByTitle('Выключить микрофон',{exact:true}).click();expect(await pa.evaluate(()=>window.rtcConnections[0].getSenders().find(s=>s.track?.kind==='audio').track.enabled)).toBe(false);
  await pa.screenshot({path:'test-results/call-connecting.png',fullPage:true});await pa.getByTitle('Завершить',{exact:true}).click();await expect(pb.locator('.callOverlay')).toHaveCount(0);expect(await pa.evaluate(()=>window.rtcConnections[0].getSenders().every(s=>!s.track||s.track.readyState==='ended'))).toBe(true);
  await pa.locator('.conversation').filter({hasText:'Команда дизайна'}).click();await pb.locator('.conversation').filter({hasText:'Команда дизайна'}).click();
  await pa.getByTitle('Групповая видеокомната',{exact:true}).click();await pb.getByTitle('Групповая видеокомната',{exact:true}).click();await expect(pa.locator('.groupVideoTile')).toHaveCount(2);await expect(pb.locator('.groupVideoTile')).toHaveCount(2);
  await pa.screenshot({path:'test-results/group-video.png',fullPage:true});await pa.getByRole('button',{name:'Выйти из комнаты'}).click();await expect(pb.locator('.groupVideoTile')).toHaveCount(1);await pb.getByRole('button',{name:'Выйти из комнаты'}).click();
 } finally {await ca.close();await cb.close();}
});
test('loaded history survives sync, old updates arrive, stale draft cannot replace local typing',async({page,request})=>{
 const auth=await account(request,'history');const chat=(await api(request,auth,'/conversations')).conversations.find(c=>c.isSaved);const created=[];
 for(let i=0;i<55;i++)created.push((await api(request,auth,`/conversations/${chat.id}/messages`,'POST',{body:`История ${i}`})).message);
 await open(page,auth);await saved(page);await expect(page.locator('.messageRow')).toHaveCount(50);await page.getByRole('button',{name:'Загрузить более ранние сообщения'}).click();await expect(page.locator('.messageRow')).toHaveCount(55);
 await api(request,auth,`/messages/${created[0].id}`,'PATCH',{body:'Старое сообщение обновлено'});await page.evaluate(()=>window.dispatchEvent(new Event('messenger:sync-now')));await expect(page.locator('.messageRow')).toHaveCount(55);await expect(page.locator('.messageRow').filter({hasText:'Старое сообщение обновлено'})).toHaveCount(1);
 await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill('Не затирать локальный текст');await page.evaluate(id=>window.dispatchEvent(new CustomEvent('messenger:draft-sync',{detail:{conversationId:id,body:'Старый облачный черновик',updatedAt:'2020-01-01T00:00:00.000Z'}})),chat.id);await expect(page.getByRole('textbox',{name:'Сообщение',exact:true})).toHaveValue('Не затирать локальный текст');
});
test('media album preserves individual actions and Mini App cannot read account storage',async({page,request})=>{
 const auth=await account(request,'album');await open(page,auth);await saved(page);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=','base64');await page.locator('input[type=file]').setInputFiles([{name:'album-a.png',mimeType:'image/png',buffer:png},{name:'album-b.png',mimeType:'image/png',buffer:png}]);await expect(page.locator('.albumItem')).toHaveCount(2);await expect(page.locator('.albumItem .messageImage')).toHaveCount(2);expect(await page.locator('.albumItem').evaluateAll(items=>items[0].dataset.album===items[1].dataset.album)).toBe(true);
 const bot=await api(request,auth,'/bots','POST',{username:unique('sandbox')+'_bot',displayName:'Помощник'});await api(request,{token:bot.token},'/botapi/setMiniApp','POST',{url:'https://mini.example.org/app'});const chat=(await api(request,auth,`/bots/${bot.bot.username}/start`,'POST',{})).conversation;
 await page.route('https://mini.example.org/**',route=>route.fulfill({contentType:'text/html',body:'<html><body><p id="state">START</p><script>try{parent.localStorage.getItem("messenger_token");document.getElementById("state").textContent="UNSAFE"}catch{document.getElementById("state").textContent="ISOLATED"}</script></body></html>'}));await page.evaluate(()=>window.dispatchEvent(new Event('messenger:sync-now')));await expect(page.locator('.conversation').filter({hasText:'Помощник'})).toBeVisible();await page.locator('.conversation').filter({hasText:'Помощник'}).click();await page.getByTitle('Открыть Mini App',{exact:true}).click();await expect(page.frameLocator('iframe').locator('#state')).toHaveText('ISOLATED');await expect(page.locator('iframe')).not.toHaveAttribute('sandbox',/allow-same-origin/);await page.keyboard.press('Escape');
});
test('phone touch actions, keyboard chat selection, multi-message selection and theme contrast',async({browser,request})=>{
 const auth=await account(request,'touch');const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage();
 try {await open(page,auth);await page.locator('.conversation').first().focus();await page.keyboard.press('Enter');await send(page,'Сообщение на телефоне');await expect(page.getByTitle('Выбрать сообщение',{exact:true})).toBeVisible();await page.getByTitle('Выбрать сообщение',{exact:true}).click();await expect(page.getByRole('toolbar',{name:'Выбранные сообщения'})).toContainText('Выбрано: 1');await page.getByRole('button',{name:'Отменить выбор'}).click();expect(await page.evaluate(()=>document.body.scrollWidth)).toBe(390);await page.screenshot({path:'test-results/touch-mobile.png',fullPage:true});await page.getByRole('button',{name:'К списку чатов'}).click();await expect(page.locator('.conversation').first()).toBeVisible();await page.screenshot({path:'test-results/list-mobile.png',fullPage:true});}finally{await context.close();}
});
