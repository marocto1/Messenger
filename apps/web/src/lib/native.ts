type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
export async function registerNativeSession(api: Api, openLink: (url: string) => void, back: () => boolean): Promise<() => void> {
  let disposed = false; const remove: (() => void)[] = [];
  const track = async (listener: Promise<{ remove(): Promise<void> }>) => { const handle = await listener; if (disposed) void handle.remove(); else remove.push(() => { void handle.remove(); }); };
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const link = await import('@tauri-apps/plugin-deep-link');
      for (const url of await link.getCurrent() || []) openLink(url);
      const unlisten = await link.onOpenUrl(urls => urls.forEach(openLink)); remove.push(unlisten);
    } catch {}
    const permission = async () => { const plugin = await import('@tauri-apps/plugin-notification'); await plugin.requestPermission(); };
    window.addEventListener('messenger:enable-push', permission); remove.push(() => window.removeEventListener('messenger:enable-push', permission));
  }
  try {
    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const { App } = await import('@capacitor/app');
      const launch = await App.getLaunchUrl(); if (launch?.url) openLink(launch.url);
      await track(App.addListener('appUrlOpen', ({ url }) => openLink(url)));
      await track(App.addListener('appStateChange', ({ isActive }) => { if (isActive) { window.dispatchEvent(new Event('messenger:resume')); window.dispatchEvent(new Event('messenger:sync-now')); } }));
      if (Capacitor.getPlatform() === 'android') await track(App.addListener('backButton', () => { if (!back()) void App.minimizeApp(); }));
      const { PushNotifications } = await import('@capacitor/push-notifications');
      await track(PushNotifications.addListener('registration', ({ value }) => { void api('/push/devices', { method:'POST', body:JSON.stringify({ token:value, platform:Capacitor.getPlatform(), deviceName:navigator.userAgent.slice(0,100) }) }).catch(() => {}); }));
      await track(PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => { if (notification.data?.conversationId) openLink(`marocto-messenger://chat/${encodeURIComponent(notification.data.conversationId)}`); }));
      const enable = async () => {
        try { let permission = await PushNotifications.checkPermissions(); if (permission.receive === 'prompt') permission = await PushNotifications.requestPermissions(); if (permission.receive === 'granted') await PushNotifications.register(); else window.dispatchEvent(new CustomEvent('messenger:native-error', { detail:'Уведомления запрещены в настройках устройства.' })); }
        catch { window.dispatchEvent(new CustomEvent('messenger:native-error', { detail:'Push недоступен. Проверь настройки Firebase.' })); }
      };
      window.addEventListener('messenger:enable-push', enable); remove.push(() => window.removeEventListener('messenger:enable-push', enable));
      if ((await PushNotifications.checkPermissions()).receive === 'granted') void enable();
      if (Capacitor.getPlatform() === 'android') {
        type Share = { text?: string; files?: string[] };
        const ShareTarget = registerPlugin<{ getInitialShare(): Promise<Share>; readSharedFile(options:{uri:string}):Promise<{path:string;name:string;mimeType:string}>; addListener(event:'shareReceived', listener:(data:Share)=>void):Promise<{remove():Promise<void>}> }>('ShareTarget');
        const receive = async (data: Share) => {
          if (disposed) return;
          if (data.text) { localStorage.setItem('messenger_pending_share_text', data.text); window.dispatchEvent(new CustomEvent('messenger:share-text', { detail:{text:data.text} })); }
          for (const uri of data.files || []) {
            try {
              const shared = await ShareTarget.readSharedFile({ uri });
              const response = await fetch(Capacitor.convertFileSrc(shared.path));
              if (!response.ok) throw new Error('share');
              const blob = await response.blob(); const file = new File([blob], shared.name, { type:shared.mimeType });
              const target = window as typeof window & { messengerSharedFiles?: File[] }; (target.messengerSharedFiles ||= []).push(file);
              window.dispatchEvent(new Event('messenger:share-file'));
            } catch { window.dispatchEvent(new CustomEvent('messenger:native-error', { detail:'Не удалось открыть файл из другого приложения. Выбери его через скрепку.' })); }
          }
        };
        await receive(await ShareTarget.getInitialShare()); await track(ShareTarget.addListener('shareReceived', data => { void receive(data); }));
      }
    }
  } catch {}
  return () => { disposed = true; remove.forEach(fn => fn()); };
}
