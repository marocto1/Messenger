'use client';

import dynamic from 'next/dynamic';
import Image from 'next/image';
import type { Dispatch,SetStateAction } from 'react';
import { FormEvent,useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { Avatar } from '../components/Avatar';
import { CallHistoryModal,CallOverlay,VoiceRoomOverlay,useCallController,useVoiceRoomController } from '../components/calls';
import { Brand,Icon,Modal,dialogs } from '../components/ui';
import { registerNativeSession } from '../lib/native';
const SettingsModal = dynamic(() => import('../components/Settings'), { ssr: false });

import type { Activity,Attachment,CallMode,CallSocketEvent,ChatFolder,Conversation,MediaGalleryItem,Message,OutboxItem,RoomSocketEvent,SocketEvent,User } from '../lib/types';

import { API_URL,WS_URL,setIceServers } from '../lib/config';
import { formatBytes,formatListTime,formatMessageTime,formatRelative,formatRelativeFuture,renderMessageText,roleLabel } from '../lib/format';
function outboxKey(userId: string) { return `messenger_outbox:${userId}`; }
function readOutbox(userId: string): OutboxItem[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(outboxKey(userId)) || '[]') as OutboxItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function writeOutbox(userId: string, items: OutboxItem[]) {
  window.localStorage.setItem(outboxKey(userId), JSON.stringify(items));
  window.dispatchEvent(new CustomEvent('messenger:outbox-changed'));
}
function enqueueOutbox(userId: string, item: OutboxItem) {
  const items = readOutbox(userId);
  if (items.length >= 200) throw new Error('Исходящие заполнены. Дождись отправки или удали неотправленные сообщения.');
  if (!items.some((entry) => entry.id === item.id)) items.push(item);
  writeOutbox(userId, items);
}
function parseMessengerLink(raw: string): { kind: 'invite' | 'chat'; value: string } | null {
  try {
    const url = new URL(raw);
    if (url.protocol === 'marocto-messenger:') {
      const kind = url.hostname;
      const value = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if ((kind === 'invite' || kind === 'chat') && value) return { kind, value };
    }
    const invite = url.searchParams.get('invite');
    if (invite) return { kind: 'invite', value: invite };
    const chat = url.searchParams.get('chat');
    if (chat) return { kind: 'chat', value: chat };
  } catch {}
  return null;
}

const CACHE_DB = 'messenger-cache-v1';
function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}
async function cacheSet(key: string, value: unknown) {
  const db = await openCacheDb(); if (!db) return;
  await new Promise<void>((resolve) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); });
  db.close();
}
async function cacheGet<T>(key: string): Promise<T | null> {
  const db = await openCacheDb(); if (!db) return null;
  return new Promise((resolve) => { const tx = db.transaction('kv', 'readonly'); const req = tx.objectStore('kv').get(key); req.onsuccess = () => { resolve((req.result ?? null) as T | null); db.close(); }; req.onerror = () => { resolve(null); db.close(); }; });
}
function conversationsCacheKey(userId: string) { return `conversations:${userId}`; }
function messagesCacheKey(userId: string, conversationId: string) { return `messages:${userId}:${conversationId}`; }
function syncCursorKey(userId: string) { return `messenger_sync_cursor:${userId}`; }

async function showBackgroundNotification(title: string, body: string) {
  try {
    const maybeTauri = typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
    if (maybeTauri) {
      const mod = await import('@tauri-apps/plugin-notification');
      let granted = await mod.isPermissionGranted();
      if (!granted) granted = (await mod.requestPermission()) === 'granted';
      if (granted) { mod.sendNotification({ title, body }); return; }
    }
  } catch {}
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
}

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const [typingChats,setTypingChats] = useState<Record<string,Set<string>>>({});
  const typingExpiry = useRef(new Map<string,ReturnType<typeof setTimeout>>());
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityUnread, setActivityUnread] = useState(0);
  const [callsOpen, setCallsOpen] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [connectionState, setConnectionState] = useState<'connecting' | 'online' | 'reconnecting' | 'offline'>('connecting');
  const [outboxCount, setOutboxCount] = useState(0);
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const [liveSocket, setLiveSocket] = useState<WebSocket | null>(null);
  const [startupError, setStartupError] = useState('');
  const meId = me?.id || '';
  const flushing = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const refreshSequence = useRef(0);
  const conversationsRef = useRef<Conversation[]>([]);
  const callController = useCallController(socketRef);
  const voiceRoomController = useVoiceRoomController(socketRef);
  const callEvents = useRef(callController.handleSocketEvent);
  const roomEvents = useRef(voiceRoomController.handleSocketEvent);
  useEffect(() => { callEvents.current = callController.handleSocketEvent; roomEvents.current = voiceRoomController.handleSocketEvent; }, [callController.handleSocketEvent, voiceRoomController.handleSocketEvent]);

  const api = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`${API_URL}${path}`, { ...init, headers, signal: init.signal || AbortSignal.timeout(20000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401 && payload.error === 'UNAUTHORIZED') window.dispatchEvent(new Event('messenger:unauthorized'));
      throw Object.assign(new Error(payload.message || `HTTP ${response.status}`), { status: response.status });
    }
    if (response.status === 204) return undefined as T;
    return response.json();
  }, [token]);

  useEffect(() => { const saved = window.localStorage.getItem('messenger_theme') || 'midnight'; document.documentElement.dataset.theme = saved; }, []);
  useEffect(() => () => { typingExpiry.current.forEach(timer=>clearTimeout(timer)); }, []);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

  const refreshConversations = useCallback(async () => {
    if (!token) return;
    const sequence = ++refreshSequence.current;
    const data = await api<{ conversations: Conversation[] }>('/conversations');
    if (sequence !== refreshSequence.current) return;
    setConversations(data.conversations);
    if (meId) void cacheSet(conversationsCacheKey(meId), data.conversations);
    setActiveId((current) => current && data.conversations.some(chat => chat.id === current) ? current : null);
  }, [api, meId, token]);

  const markRead = useCallback(async (conversationId: string) => {
    try {
      await api(`/conversations/${conversationId}/read`, { method: 'POST' });
      setConversations((current) => current.map((chat) => chat.id === conversationId ? { ...chat, unreadCount: 0, mentionCount: 0 } : chat));
    } catch {}
  }, [api]);

  const refreshOutboxCount = useCallback(() => { setOutboxCount(meId ? readOutbox(meId).length : 0); }, [meId]);
  const flushOutbox = useCallback(async () => {
    if (!meId || !navigator.onLine || flushing.current) return;
    flushing.current = true; let delivered = false;
    try {
      for (const item of readOutbox(meId)) {
        if (item.failed) continue;
        try {
          const data = await api<{ message: Message }>(`/conversations/${item.conversationId}/messages`, { method: 'POST', body: JSON.stringify({ body: item.body, replyToId: item.replyToId, attachmentId: item.attachmentId, albumId: item.albumId, clientRequestId: item.id }) });
          writeOutbox(meId, readOutbox(meId).filter(entry => entry.id !== item.id)); delivered = true;
          if (activeIdRef.current === item.conversationId) setMessages(current => current.some(m => m.id === data.message.id) ? current : [...current, data.message]);
        } catch (error) {
          const status = (error as { status?: number }).status;
          writeOutbox(meId, readOutbox(meId).map(entry => entry.id !== item.id ? entry : { ...entry, attempts: entry.attempts + 1, failed: !!status && status < 500 && status !== 429, lastError: error instanceof Error ? error.message : 'Ошибка сети' }));
          if (!status || status >= 500 || status === 429) break;
        }
      }
    } finally { flushing.current = false; refreshOutboxCount(); }
    if (delivered) await refreshConversations().catch(() => {});
  }, [api, meId, refreshConversations, refreshOutboxCount]);

  useEffect(() => {
    if (!meId) return;
    const timer = window.setInterval(() => { if (readOutbox(meId).some(item => !item.failed)) void flushOutbox(); }, 5000);
    return () => window.clearInterval(timer);
  }, [flushOutbox, meId]);

  useEffect(() => { if (token) void api<{ iceServers: RTCIceServer[] }>('/rtc/config').then(data => setIceServers(data.iceServers)).catch(() => {}); }, [api, token]);

  useEffect(() => {
    const saved = window.localStorage.getItem('messenger_token');
    if (!saved) { setLoading(false); return; }
    setToken(saved);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      let cachedUser: User | null = null;
      try { cachedUser = JSON.parse(window.localStorage.getItem('messenger_user') || 'null'); } catch {}
      if (cachedUser) {
        const chats = await cacheGet<Conversation[]>(conversationsCacheKey(cachedUser.id));
        if (!cancelled) { setMe(cachedUser); if (chats) setConversations(chats); }
      }
      try {
        const data = await api<{ user: User }>('/me');
        if (cancelled) return;
        setMe(data.user); window.localStorage.setItem('messenger_user', JSON.stringify(data.user)); setStartupError('');
        const sequence = ++refreshSequence.current;
        const [chats,folderData,activity] = await Promise.all([
          api<{ conversations: Conversation[] }>('/conversations'),
          api<{ folders: ChatFolder[] }>('/folders'),
          api<{ unread:number }>('/activity?limit=1')
        ]);
        if (cancelled) return;
        if (sequence === refreshSequence.current) { setConversations(chats.conversations); void cacheSet(conversationsCacheKey(data.user.id),chats.conversations); }
        setFolders(folderData.folders); setActivityUnread(activity.unread);
      } catch (error) {
        if (cancelled) return;
        if ((error as { status?: number }).status === 401) { window.localStorage.removeItem('messenger_token'); window.localStorage.removeItem('messenger_user'); setToken(null); setMe(null); }
        else { setStartupError(cachedUser ? '' : 'Сервер недоступен. Проверь подключение и повтори попытку.'); setConnectionState('offline'); }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [api, token]);
  useEffect(() => {
    const unauthorized = () => { window.localStorage.removeItem('messenger_token'); window.localStorage.removeItem('messenger_user'); setToken(null); setMe(null); setConversations([]); setActiveId(null); };
    window.addEventListener('messenger:unauthorized', unauthorized);
    return () => window.removeEventListener('messenger:unauthorized', unauthorized);
  }, []);

  useEffect(() => {
    if (!token || !meId) return;
    const invite = new URLSearchParams(window.location.search).get('invite');
    if (!invite) return;
    let cancelled = false;
    void api<{ conversation: Conversation }>(`/invites/${encodeURIComponent(invite)}/join`, { method: 'POST' })
      .then(async ({ conversation }) => {
        if (cancelled) return;
        await refreshConversations();
        setActiveId(conversation.id);
        const url = new URL(window.location.href);
        url.searchParams.delete('invite');
        window.history.replaceState({}, '', url.pathname + url.search + url.hash);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [api, meId, refreshConversations, token]);

  useEffect(() => {
    refreshOutboxCount();
    const onChanged = () => refreshOutboxCount();
    const onOnline = () => { setConnectionState('reconnecting'); void flushOutbox(); };
    const onOffline = () => setConnectionState('offline');
    window.addEventListener('messenger:outbox-changed', onChanged);
    window.addEventListener('messenger:flush-outbox', onOnline);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('messenger:outbox-changed', onChanged);
      window.removeEventListener('messenger:flush-outbox', onOnline);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [flushOutbox, refreshOutboxCount]);

  useEffect(() => {
    if (!token || !meId) return;
    let disposed = false; let cleanup: (() => void) | undefined;
    const openLink = async (raw: string) => {
      const link = parseMessengerLink(raw); if (!link || disposed) return;
      try {
        if (link.kind === 'invite') { const data = await api<{ conversation: Conversation }>(`/invites/${encodeURIComponent(link.value)}/join`, { method:'POST' }); await refreshConversations(); if (!disposed) setActiveId(data.conversation.id); }
        else { await refreshConversations(); if (!disposed) setActiveId(link.value); }
      } catch (error) { await dialogs.alert(error instanceof Error ? error.message : 'Не удалось открыть ссылку.'); }
    };
    const back = () => { if (document.querySelector('[role="dialog"]')) { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })); return true; } if (document.querySelector('.callOverlay,.voiceRoomOverlay')) return true; if (activeIdRef.current) { setActiveId(null); return true; } return false; };
    void registerNativeSession(api, raw => { void openLink(raw); }, back).then(fn => { if (disposed) fn(); else cleanup = fn; });
    const nativeError = (event: Event) => { void dialogs.alert(String((event as CustomEvent).detail)); };
    window.addEventListener('messenger:native-error', nativeError);
    return () => { disposed = true; cleanup?.(); window.removeEventListener('messenger:native-error', nativeError); };
  }, [api, meId, refreshConversations, token]);

  useEffect(() => {
    if (!token || !meId) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retry = 0;
    let currentSocket: WebSocket | null = null;

    const connect = () => {
      if (disposed || !navigator.onLine) { setConnectionState('offline'); return; }
      setConnectionState(retry ? 'reconnecting' : 'connecting');
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      currentSocket = ws;
      socketRef.current = ws; setLiveSocket(ws);

      ws.onopen = () => {
        retry = 0;
        setConnectionState('online');
        void flushOutbox(); void refreshConversations();
        window.dispatchEvent(new CustomEvent('messenger:sync-now'));
      };

      ws.onmessage = (event) => {
        let payload: SocketEvent; try { payload = JSON.parse(event.data); } catch { return; }
        if (!payload || typeof payload.type !== 'string') return;
        if (payload.type.startsWith('call:')) {
          void callEvents.current(payload as CallSocketEvent).catch(error => { void dialogs.alert(error instanceof Error ? error.message : 'Не удалось установить звонок.'); });
          return;
        }
        if (payload.type.startsWith('room:')) {
          void roomEvents.current(payload as RoomSocketEvent).catch(error => { void dialogs.alert(error instanceof Error ? error.message : 'Не удалось подключиться к комнате.'); });
          return;
        }
        if (payload.type === 'message:new') {
          setMessages((current) => {
            if (payload.message.conversationId !== activeIdRef.current) return current;
            if (current.some((message) => message.id === payload.message.id)) return current;
            return [...current, payload.message];
          });
          if (payload.message.conversationId === activeIdRef.current && payload.message.senderId !== meId && !document.hidden) {
            void markRead(payload.message.conversationId);
          }
          const chat = conversationsRef.current.find((item) => item.id === payload.message.conversationId);
          if (payload.message.senderId !== meId && chat && !chat.muted && document.hidden) {
            void showBackgroundNotification(chat.title, payload.message.body || (payload.message.attachment ? `📎 ${payload.message.attachment.fileName}` : 'Новое сообщение'));
          }
          void refreshConversations();
        } else if (payload.type === 'message:updated' || payload.type === 'message:deleted') {
          setMessages((current) => current.map((message) => message.id === payload.message.id ? payload.message : message));
          void refreshConversations();
        } else if (payload.type === 'typing') {
          const key = `${payload.conversationId}:${payload.userId}`;
          const previousTimer = typingExpiry.current.get(key); if (previousTimer) clearTimeout(previousTimer);
          const update = (active:boolean) => {
            setTypingChats(current => { const users=new Set(current[payload.conversationId] || []); if(active)users.add(payload.userId);else users.delete(payload.userId);return {...current,[payload.conversationId]:users}; });
            if(payload.conversationId===activeIdRef.current) setTypingUsers(current=>{const users=new Set(current);if(active)users.add(payload.userId);else users.delete(payload.userId);return users;});
          };
          update(payload.active);
          if(payload.active) typingExpiry.current.set(key,setTimeout(()=>{update(false);typingExpiry.current.delete(key);},5000));
          else typingExpiry.current.delete(key);
        } else if (payload.type === 'presence') {
          setPresence((current) => ({ ...current, [payload.userId]: payload.online }));
        } else if (payload.type === 'conversation:read') {
          setMessages((current) => current.map((message) => (
            message.conversationId === payload.conversationId &&
            message.senderId === meId &&
            new Date(message.createdAt).getTime() <= new Date(payload.at).getTime()
              ? { ...message, readByOther: true }
              : message
          )));
        } else if (payload.type === 'message:reaction') {
          void api<{ message: Message }>(`/messages/${payload.messageId}`).then(({ message }) => {
            setMessages((current) => current.map((item) => item.id === message.id ? message : item));
          }).catch(() => {});
        } else if (payload.type === 'conversation:updated') {
          void refreshConversations();
        } else if (payload.type === 'conversation:added') {
          void refreshConversations();
        } else if (payload.type === 'conversation:removed') {
          setConversations((current) => current.filter((chat) => chat.id !== payload.conversationId));
          if (activeIdRef.current === payload.conversationId) setActiveId(null);
        } else if (payload.type === 'privacy:updated') {
          setPresence((current) => ({ ...current, [payload.userId]: false }));
          void refreshConversations();
        } else if (payload.type === 'channel:comments') {
          void api<{ message: Message }>(`/messages/${payload.postId}`).then(({ message }) => {
            setMessages((current) => current.map((item) => item.id === message.id ? message : item));
          }).catch(() => {});
        } else if (payload.type === 'activity:new') {
          setActivityUnread((count) => count + 1);
        } else if (payload.type === 'activity:read') {
          setActivityUnread(0);
        } else if (payload.type === 'draft:updated') {
          window.dispatchEvent(new CustomEvent('messenger:draft-sync', { detail: payload }));
        } else if (payload.type === 'scheduled:sent') {
          if (payload.message.conversationId === activeIdRef.current) setMessages((current) => current.some((item) => item.id === payload.message.id) ? current : [...current, payload.message]);
          void refreshConversations();
        } else if (payload.type === 'scheduled:failed') {
          void showBackgroundNotification('Не удалось отправить сообщение', payload.message);
        }
      };

      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onclose = (event) => {
        if (event.code === 4001 && !disposed) { window.dispatchEvent(new Event('messenger:unauthorized')); return; }
        if (currentSocket !== ws) return;
        if (socketRef.current === ws) { socketRef.current = null; setLiveSocket(null); }
        if (disposed) return;
        setConnectionState(navigator.onLine ? 'reconnecting' : 'offline');
        if (!navigator.onLine) return;
        const delay = Math.min(15_000, 750 * (2 ** Math.min(retry, 4)));
        retry += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    const reconnectNow = () => {
      if (disposed) return;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (!currentSocket || currentSocket.readyState === WebSocket.CLOSED || currentSocket.readyState === WebSocket.CLOSING) connect();
      void flushOutbox();
    };

    connect();
    window.addEventListener('online', reconnectNow);
    const onVisible = () => { if (!document.hidden) { reconnectNow(); window.dispatchEvent(new Event('messenger:sync-now')); } };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('messenger:resume', reconnectNow);
    return () => {
      disposed = true;
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('messenger:resume', reconnectNow);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current = null;
      try { currentSocket?.close(); } catch {}
    };
  }, [api, flushOutbox, meId, markRead, refreshConversations, token]);

  useEffect(() => {
    if (!activeId || !token || !meId) { setMessages([]); setHasMoreMessages(false); return; }
    let cancelled = false;
    setTypingUsers(new Set()); setMessages([]);
    (async () => {
      const cached = await cacheGet<Message[]>(messagesCacheKey(meId, activeId));
      if (!cancelled && cached?.length) setMessages(cached);
      const data = await api<{ messages: Message[]; hasMore: boolean }>(`/conversations/${activeId}/messages?limit=50`);
      if (!cancelled) { setMessages(data.messages); setHasMoreMessages(Boolean(data.hasMore)); void cacheSet(messagesCacheKey(meId, activeId), data.messages); }
      if (!cancelled && !document.hidden) await markRead(activeId);
    })().catch(() => { if (!cancelled) setConnectionState('offline'); });
    return () => { cancelled = true; };
  }, [activeId, api, markRead, meId, token]);

  useEffect(() => {
    if (!meId || !token) return;
    let stopped = false; let syncing = false;
    const run = async () => {
      if (stopped || syncing || !navigator.onLine) return; syncing = true;
      let cursor = Number(window.localStorage.getItem(syncCursorKey(meId)) || 0) || 0;
      let touchedActive = false; let resetNeeded = false; const changes: Message[] = [];
      try {
        for (let page = 0; page < 4; page++) {
          const data = await api<{ cursor: number; hasMore: boolean; resetNeeded?: boolean; events: { seq: number; type: string; conversationId: string | null; payload: Record<string, unknown> }[] }>(`/sync?after=${cursor}&limit=200`);
          resetNeeded ||= !!data.resetNeeded;
          for (const event of data.events) {
            if (event.type === 'draft:updated') window.dispatchEvent(new CustomEvent('messenger:draft-sync', { detail: { type: 'draft:updated', conversationId: event.conversationId, ...(event.payload || {}) } }));
            if (event.conversationId && event.conversationId === activeIdRef.current && event.type.startsWith('message:')) { touchedActive = true; if (event.payload.message) changes.push(event.payload.message as Message); }
          }
          cursor = data.cursor;
          window.localStorage.setItem(syncCursorKey(meId), String(cursor));
          if (!data.hasMore) break;
        }
        await refreshConversations();
        if (touchedActive && activeIdRef.current) {
          const activeConversationId = activeIdRef.current;
          const data = await api<{ messages: Message[]; hasMore: boolean }>(`/conversations/${activeConversationId}/messages?limit=50`);
          if (!stopped && activeIdRef.current === activeConversationId) { setMessages(current => { const byId = new Map((resetNeeded ? [] : current).map(message => [message.id,message])); for (const message of [...data.messages, ...changes]) byId.set(message.id,message); return [...byId.values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); }); if (resetNeeded) setHasMoreMessages(data.hasMore); }
        }
      } catch {} finally { syncing = false; }
    };
    const onSync = () => void run();
    window.addEventListener('messenger:sync-now', onSync);
    const timer = window.setInterval(run, 15000);
    void run();
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('messenger:sync-now', onSync); };
  }, [api, meId, refreshConversations, token]);

  useEffect(() => { if (meId && activeId && messages.length) void cacheSet(messagesCacheKey(meId, activeId), messages.slice(-200)); }, [meId, activeId, messages]);

  const active = conversations.find((conversation) => conversation.id === activeId) || null;

  const handleAuth = (newToken: string, user: User) => {
    window.localStorage.setItem('messenger_token', newToken);
    window.localStorage.setItem('messenger_user', JSON.stringify(user));
    setToken(newToken);
    setMe(user);
    setLoading(false);
  };

  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    window.localStorage.removeItem('messenger_token');
    setToken(null);
    setMe(null);
    setConversations([]);
    setActiveId(null);
  };

  if (loading) return <LoadingScreen />;
  if (startupError && token && !me) return <main className="authPage"><section className="authCard"><Brand /><h1>Нет соединения</h1><p role="alert">{startupError}</p><button className="primaryButton" onClick={() => window.location.reload()}>Повторить подключение</button><button className="secondaryButton" onClick={() => void logout()}>Другой аккаунт</button></section></main>;
  if (!token || !me) return <AuthScreen onAuth={handleAuth} />;

  return (
    <main className={`shell ${activeId ? 'hasConversation' : ''}`}>
      <nav className="navigationRail" aria-label="Навигация"><Brand small /><button className="active" aria-label="Сообщения" title="Сообщения" onClick={() => setActiveId(null)}><Icon name="chat" /></button><button aria-label="Звонки" title="Звонки" onClick={() => setCallsOpen(true)}><Icon name="phone" /></button><button aria-label="Активность" title="Активность" onClick={() => setActivityOpen(true)}><Icon name="bell" />{activityUnread > 0 && <i className="railDot" />}</button><span className="railSpacer" /><button aria-label="Настройки" title="Настройки" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button><button aria-label="Выйти" title="Выйти" onClick={() => void logout()}><Icon name="logout" /></button></nav>
      <Sidebar
        token={token}
        me={me}
        conversations={conversations}
        folders={folders}
        typingChats={typingChats}
        activeId={activeId}
        presence={presence}
        onSelect={setActiveId}
        onCreated={(conversation) => {
          setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
          setActiveId(conversation.id);
        }}
        api={api}
        onLogout={logout}
        activityUnread={activityUnread}
        onActivity={() => setActivityOpen(true)}
        onCalls={() => setCallsOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onFoldersChanged={async () => { const data = await api<{ folders: ChatFolder[] }>('/folders'); setFolders(data.folders); await refreshConversations(); }}
      />
      <ChatPanel
        key={activeId || 'empty'}
        onBack={() => setActiveId(null)}
        token={token}
        me={me}
        conversation={active}
        conversations={conversations}
        messages={messages}
        setMessages={setMessages}
        hasMoreMessages={hasMoreMessages}
        setHasMoreMessages={setHasMoreMessages}
        connectionState={connectionState}
        outboxCount={outboxCount}
        typingUsers={typingUsers}
        presence={presence}
        socket={liveSocket}
        refreshConversations={refreshConversations}
        api={api}
        onStartCall={callController.startCall}
        onJoinVoiceRoom={voiceRoomController.joinRoom}
        voiceRoomConversationId={voiceRoomController.room?.conversationId || null}
      />
      {settingsOpen && <SettingsModal token={token} me={me} api={api} onMeUpdated={setMe} onClose={() => setSettingsOpen(false)} />}
      {activityOpen && <ActivityModal api={api} onUnread={setActivityUnread} onNavigate={(conversationId, messageId) => { setActiveId(conversationId); setActivityOpen(false); if (messageId) window.setTimeout(() => document.getElementById(`message-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350); }} onClose={() => setActivityOpen(false)} />}
      {callsOpen && <CallHistoryModal token={token} api={api} onClose={() => setCallsOpen(false)} />}
      <CallOverlay token={token} controller={callController} />
      <VoiceRoomOverlay token={token} controller={voiceRoomController} />
    </main>
  );
}


function AuthScreen({ onAuth }: { onAuth: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorChallenge, setTwoFactorChallenge] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const finishAuth = (data: { token: string; user: User }) => onAuth(data.token, data.user);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (twoFactorChallenge) {
        const response = await fetch(`${API_URL}/auth/2fa/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: twoFactorChallenge, code: twoFactorCode }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Неверный код 2FA'); finishAuth(data); return;
      }
      const response = await fetch(`${API_URL}/auth/${mode === 'register' ? 'register' : 'login'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, displayName, password }) });
      const data = await response.json();
      if (response.status === 202 && data.requiresTwoFactor) { setTwoFactorChallenge(data.challengeId); setTwoFactorCode(''); return; }
      if (!response.ok) throw new Error(data.message || 'Ошибка входа'); finishAuth(data);
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка'); }
    finally { setBusy(false); }
  };

  const loginWithPasskey = async () => {
    if (!username.trim()) { setError('Сначала введи @username.'); return; }
    setBusy(true); setError('');
    try {
      const optionsResponse = await fetch(`${API_URL}/auth/passkeys/options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
      const optionsData = await optionsResponse.json(); if (!optionsResponse.ok) throw new Error(optionsData.message || 'Passkey недоступен');
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const response = await startAuthentication({ optionsJSON: optionsData.options });
      const verifyResponse = await fetch(`${API_URL}/auth/passkeys/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: optionsData.challengeId, response }) });
      const verified = await verifyResponse.json(); if (!verifyResponse.ok) throw new Error(verified.message || 'Passkey не подтверждён'); finishAuth(verified);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось войти с passkey'); }
    finally { setBusy(false); }
  };

  const switchMode = (next: 'login' | 'register') => { setMode(next); setTwoFactorChallenge(null); setTwoFactorCode(''); setError(''); };

  return <main className="authPage"><section className="authCard">
    <Brand /><div className="eyebrow">MAROCTO · MESSENGER 1.0</div><h1>Messenger</h1>
    <p className="muted">Ближе к людям. Сообщения, файлы и звонки в твоём собственном пространстве.</p>
    {!twoFactorChallenge && <div className="authTabs"><button className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>Создать аккаунт</button><button className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>Войти</button></div>}
    <form onSubmit={submit} className="authForm">
      {twoFactorChallenge ? <><div className="securityPrompt"><b>Двухфакторная защита</b><span>Введи код аутентификатора или одноразовый код восстановления.</span></div><label>Код 2FA<input autoFocus autoComplete="one-time-code" maxLength={19} value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 19))} placeholder="000000" /></label></> : <>
        {mode === 'register' && <label>Имя<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Marocto" autoComplete="name" /></label>}
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@marocto" autoCapitalize="none" autoComplete="username" /></label>
        <label>Пароль<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Минимум 8 символов" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} /></label>
      </>}
      {error && <div className="errorBox">{error}</div>}
      <button className="primaryButton" disabled={busy}>{busy ? 'Подключение…' : twoFactorChallenge ? 'Подтвердить' : mode === 'register' ? 'Создать аккаунт' : 'Войти'}</button>
      {mode === 'login' && !twoFactorChallenge && <button type="button" className="passkeyLoginButton" disabled={busy} onClick={() => void loginWithPasskey()}>Войти с Passkey</button>}
      {twoFactorChallenge && <button type="button" className="secondaryButton" onClick={() => { setTwoFactorChallenge(null); setTwoFactorCode(''); }}>Назад</button>}
    </form>
  </section></main>;
}

function Sidebar({ typingChats, token, me, conversations, folders, activeId, presence, onSelect, onCreated, api, onLogout, activityUnread, onActivity, onCalls, onSettings, onFoldersChanged }: {
  typingChats: Record<string,Set<string>>;
  token: string;
  me: User;
  conversations: Conversation[];
  folders: ChatFolder[];
  activeId: string | null;
  presence: Record<string, boolean>;
  onSelect: (id: string) => void;
  onCreated: (conversation: Conversation) => void;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onLogout: () => void;
  activityUnread: number;
  onActivity: () => void;
  onCalls: () => void;
  onSettings: () => void;
  onFoldersChanged: () => Promise<void>;
}) {
  const [,redrawDrafts] = useState(0);
  useEffect(() => { const update=()=>redrawDrafts(value=>value+1); window.addEventListener('messenger:draft-changed',update); return()=>window.removeEventListener('messenger:draft-changed',update); },[]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [newMenu, setNewMenu] = useState(false);
  const [view, setView] = useState<string>('all');
  const [globalOpen, setGlobalOpen] = useState(false);
  const [contextChat, setContextChat] = useState<Conversation | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let source = conversations;
    if (view === 'all') source = source.filter((chat) => !chat.archived);
    else if (view === 'archived') source = source.filter((chat) => chat.archived);
    else if (view.startsWith('folder:')) {
      const folder = folders.find((item) => item.id === view.slice(7));
      const ids = new Set(folder?.conversationIds || []);
      source = source.filter((chat) => ids.has(chat.id));
    }
    if (!q) return source;
    return source.filter((chat) => `${chat.title} ${chat.username || ''} ${chat.publicUsername || ''}`.toLowerCase().includes(q));
  }, [conversations, folders, query, view]);

  const createChat = async () => {
    const username = (await dialogs.prompt('Username пользователя, например @alex'));
    if (!username) return;
    setCreating(true); setError(''); setNewMenu(false);
    try {
      const data = await api<{ conversation: Conversation }>('/conversations/direct', {
        method: 'POST', body: JSON.stringify({ username }),
      });
      onCreated(data.conversation);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать чат'); }
    finally { setCreating(false); }
  };

  const joinInvite = async () => {
    const raw = (await dialogs.prompt('Вставь invite-ссылку или её код'));
    if (!raw) return;
    let invite = raw.trim();
    try {
      const parsed = new URL(invite);
      invite = parsed.searchParams.get('invite') || parsed.pathname.split('/').filter(Boolean).pop() || invite;
    } catch {}
    setCreating(true); setError(''); setNewMenu(false);
    try {
      const data = await api<{ conversation: Conversation }>(`/invites/${encodeURIComponent(invite)}/join`, { method: 'POST' });
      onCreated(data.conversation);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось вступить по ссылке'); }
    finally { setCreating(false); }
  };

  const createGroup = async () => {
    const title = (await dialogs.prompt('Название новой группы'));
    if (!title) return;
    const raw = (await dialogs.prompt('Добавь участников через запятую: @alex, @jane (можно оставить пустым)', '')) ?? '';
    const usernames = raw.split(',').map((item) => item.trim()).filter(Boolean);
    setCreating(true); setError(''); setNewMenu(false);
    try {
      const data = await api<{ conversation: Conversation }>('/conversations/group', {
        method: 'POST', body: JSON.stringify({ title, usernames }),
      });
      onCreated(data.conversation);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать группу'); }
    finally { setCreating(false); }
  };


  const createChannel = async () => {
    const title = (await dialogs.prompt('Название нового канала'));
    if (!title) return;
    const rawUsername = (await dialogs.prompt('Публичный @username канала (оставь пустым для приватного)', '')) ?? '';
    const description = (await dialogs.prompt('Описание канала (необязательно)', '')) ?? '';
    setCreating(true); setError(''); setNewMenu(false);
    try {
      const data = await api<{ conversation: Conversation }>('/channels', {
        method: 'POST', body: JSON.stringify({ title, username: rawUsername, description }),
      });
      onCreated(data.conversation);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать канал'); }
    finally { setCreating(false); }
  };

  const findChannel = async () => {
    const query = (await dialogs.prompt('Название или @username публичного канала'));
    if (!query) return;
    setCreating(true); setError(''); setNewMenu(false);
    try {
      const data = await api<{ channels: { id: string; title: string; publicUsername: string | null; subscriberCount: number; subscribed: boolean }[] }>(`/channels/search?q=${encodeURIComponent(query)}`);
      if (!data.channels.length) throw new Error('Публичные каналы не найдены.');
      const listing = data.channels.slice(0, 10).map((channel, index) => `${index + 1}. ${channel.title} @${channel.publicUsername} · ${channel.subscriberCount} подписчиков${channel.subscribed ? ' · уже подписан' : ''}`).join('\n');
      const selectedRaw = (await dialogs.prompt(`Найдено:\n\n${listing}\n\nВведи номер канала`, '1'));
      const selected = data.channels[Math.max(0, Number(selectedRaw || 1) - 1)];
      if (!selected) return;
      const joined = await api<{ conversation: Conversation }>(`/channels/${encodeURIComponent(selected.publicUsername || selected.id)}/join`, { method: 'POST' });
      onCreated(joined.conversation);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось открыть канал'); }
    finally { setCreating(false); }
  };

  const updateState = async (chat: Conversation, patch: { archived?: boolean; pinned?: boolean }) => {
    try { await api(`/conversations/${chat.id}/state`, { method: 'PATCH', body: JSON.stringify(patch) }); await onFoldersChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить чат.'); }
  };
  const createFolder = async () => {
    const name = (await dialogs.prompt('Название папки')); if (!name) return;
    try { await api('/folders', { method: 'POST', body: JSON.stringify({ name }) }); await onFoldersChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать папку.'); }
  };
  const addToFolder = async (chat: Conversation) => {
    if (!folders.length) { await createFolder(); return; }
    const listing = folders.map((folder, i) => `${i + 1}. ${folder.name}`).join('\n');
    const raw = (await dialogs.prompt(`Выбери папку:\n${listing}`, '1'));
    const folder = folders[Number(raw || 1) - 1]; if (!folder) return;
    try { await api(`/folders/${folder.id}/chats/${chat.id}`, { method: 'PUT' }); await onFoldersChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось добавить в папку.'); }
  };

  return (
    <aside className="sidebar">
      <header className="sidebarHeader">
        <Avatar token={token} name={me.displayName} mediaId={me.avatarMediaId} className="profileAvatar" />
        <div className="profileText"><strong>{me.displayName}</strong><span>@{me.username}</span></div>
        <button className="iconButton" title="История звонков" onClick={onCalls}><Icon name="phone" /></button>
        <button className="iconButton activityButton" title="Активность" onClick={onActivity}>♢{activityUnread > 0 && <b>{activityUnread > 99 ? '99+' : activityUnread}</b>}</button>
        <button className="iconButton" title="Устройства и сессии" onClick={onSettings}><Icon name="settings" /></button>
        <button className="iconButton" title="Выйти" onClick={onLogout}><Icon name="logout" /></button>
      </header>
      <div className="searchRow">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск чатов" />
        <button className="globalSearchButton" title="Глобальный поиск" onClick={() => setGlobalOpen(true)}><Icon name="search" /></button>
        <div className="newChatWrap">
          <button className="newChat" onClick={() => setNewMenu((value) => !value)} disabled={creating} title="Новый чат"><Icon name="plus" /></button>
          {newMenu && <div className="newChatMenu"><button onClick={() => void createChat()}>Личный чат</button><button onClick={() => void createGroup()}>Новая группа</button><button onClick={() => void createChannel()}>Новый канал</button><button onClick={() => void findChannel()}>Найти канал</button><button onClick={() => void joinInvite()}>Вступить по ссылке</button></div>}
        </div>
      </div>
      {error && <div className="sideError">{error}</div>}
      <div className="chatFolderTabs"><button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}>Все</button><button className={view === 'archived' ? 'active' : ''} onClick={() => setView('archived')}>Архив</button>{folders.map((folder) => <button key={folder.id} className={view === `folder:${folder.id}` ? 'active' : ''} onClick={() => setView(`folder:${folder.id}`)}>{folder.name}</button>)}<button title="Новая папка" onClick={() => void createFolder()}><Icon name="plus" size={16} /></button></div>
      <div className="sectionLabel"><span>{view === 'archived' ? 'Архив' : 'Сообщения'}</span><span>{filtered.length}</span></div>
      <div className="conversationList">
        {filtered.map((chat) => {
          const peer = chat.members.find((member) => member.id !== me.id);
          const online = chat.kind === 'direct' && peer ? presence[peer.id] : false;
          return (
            <div role="button" tabIndex={0} key={chat.id} className={`conversation ${chat.id === activeId ? 'selected' : ''}`} aria-current={chat.id === activeId ? 'true' : undefined} onContextMenu={e => { e.preventDefault(); setContextChat(chat); }} onClick={() => onSelect(chat.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(chat.id); } if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const rows = Array.from(e.currentTarget.parentElement!.querySelectorAll<HTMLElement>('.conversation')); rows[(rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus(); } }}>
              <div className="avatarWrap">
                <Avatar token={token} name={chat.title} mediaId={chat.avatarMediaId} className={`chatAvatar ${chat.isSaved ? 'savedAvatar' : ''}`} fallback={chat.isSaved ? '★' : undefined} />
                {online && <i className="onlineDot" />}
              </div>
              <div className="conversationBody">
                <div className="conversationTop"><strong>{chat.pinned && <Icon name="pin" size={12} />} {chat.title}</strong><div className="conversationMeta">{chat.muted && <i title="Уведомления выключены">⌁</i>}<time>{formatListTime(chat.lastMessageAt)}</time></div></div>
                <div className="conversationBottom"><span>{(typeof window !== 'undefined' && localStorage.getItem(`messenger_draft:${me.id}:${chat.id}`)) ? `Черновик: ${localStorage.getItem(`messenger_draft:${me.id}:${chat.id}`)}` : typingChats[chat.id]?.size ? 'печатает…' : chat.lastMessage ? `${chat.kind === 'group' ? `${chat.lastMessageSenderId === me.id ? 'Вы' : chat.lastMessageSenderName || ''}: ` : chat.lastMessageSenderId === me.id && !chat.isSaved ? 'Вы: ' : ''}${chat.lastMessage}` : (chat.isSaved ? 'Личное облако' : chat.kind === 'channel' ? `${chat.subscriberCount} подписчиков${chat.publicUsername ? ` · @${chat.publicUsername}` : ''}` : chat.kind === 'group' ? `${chat.members.length} участников` : chat.username ? `@${chat.username}` : 'Новый чат')}</span>{chat.mentionCount > 0 && <b className="mentionBadge">@</b>}{chat.unreadCount > 0 && <b className="badge">{chat.unreadCount}</b>}</div>
              </div>
              {!chat.isSaved && <div className="chatQuickActions" onClick={(e) => e.stopPropagation()}><button title={chat.pinned ? 'Открепить' : 'Закрепить'} onClick={() => void updateState(chat, { pinned: !chat.pinned })}>{chat.pinned ? '★' : '☆'}</button><button title="Добавить в папку" onClick={() => void addToFolder(chat)}>▤</button><button title={chat.archived ? 'Вернуть из архива' : 'В архив'} onClick={() => void updateState(chat, { archived: !chat.archived })}>{chat.archived ? '↥' : '⌄'}</button></div>}
            </div>
          );
        })}
        {filtered.length === 0 && <div className="emptySidebar"><Icon name="search" size={28} /><b>{query ? 'Чаты не найдены' : 'Здесь появятся беседы'}</b><p>{query ? 'Попробуй другое имя или глобальный поиск.' : 'Начни новую беседу кнопкой + выше.'}</p></div>}
      </div>
      {contextChat && <Modal onClose={() => setContextChat(null)}><section className="compactModal contextChatMenu"><h2>{contextChat.title}</h2><button onClick={() => { void updateState(contextChat, { pinned: !contextChat.pinned }); setContextChat(null); }}>{contextChat.pinned ? 'Открепить чат' : 'Закрепить чат'}</button><button onClick={() => { void updateState(contextChat, { archived: !contextChat.archived }); setContextChat(null); }}>{contextChat.archived ? 'Вернуть из архива' : 'Архивировать'}</button><button onClick={() => { void addToFolder(contextChat); setContextChat(null); }}>Добавить в папку</button></section></Modal>}
      {globalOpen && <GlobalSearchModal api={api} onCreated={conversation => { onCreated(conversation); setGlobalOpen(false); }} onNavigate={(conversationId) => { onSelect(conversationId); setGlobalOpen(false); }} onClose={() => setGlobalOpen(false)} />}
    </aside>
  );
}

function GlobalSearchModal({ api, onNavigate, onCreated, onClose }: { onCreated:(conversation:Conversation)=>void; api: <T>(path: string, init?: RequestInit) => Promise<T>; onNavigate: (conversationId: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false); const [searched, setSearched] = useState(false); const [error,setError] = useState('');
  const [tab,setTab] = useState('all');
  const [results, setResults] = useState<{ conversations: Conversation[]; messages: Message[]; users: User[] }>({ conversations: [], messages: [], users: [] });
  const run = async () => {
    const q = query.trim(); if (q.length < 2) return; setBusy(true); setError('');
    try { setResults(await api(`/search?q=${encodeURIComponent(q)}`)); setSearched(true); } catch(error) { setError(error instanceof Error ? error.message : 'Поиск недоступен.'); } finally { setBusy(false); }
  };
  const mark = (text: string) => { const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')); return parts.map((part,index) => part.toLowerCase() === query.toLowerCase() ? <mark key={index}>{part}</mark> : part); };
  const messages = results.messages.filter(message => tab === 'media' ? !!message.attachment?.mimeType.match(/^(image|video|audio)\//) : tab === 'files' ? !!message.attachment && !message.attachment.mimeType.match(/^(image|video|audio)\//) : tab === 'links' ? /https?:\/\//.test(message.body) : true);
  const chats = results.conversations.filter(chat => tab !== 'channels' || chat.kind === 'channel');
  const openUser = async (user: User) => { try { const data = await api<{conversation:Conversation}>('/conversations/direct', {method:'POST',body:JSON.stringify({username:user.username})}); onCreated(data.conversation); window.dispatchEvent(new Event('messenger:sync-now')); } catch(error) { setError(error instanceof Error ? error.message : 'Чат недоступен.'); } };
  return <Modal onClose={onClose}><section className="compactModal globalSearchModal">
    <header><div><span className="eyebrow">ПОИСК</span><h2>Найди нужное</h2></div><button aria-label="Закрыть поиск" onClick={onClose}><Icon name="close" /></button></header>
    <form onSubmit={e=>{e.preventDefault();void run();}} className="globalSearchForm"><input aria-label="Поиск по мессенджеру" autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Имя, сообщение или файл…" /><button className="primaryButton" disabled={busy || query.trim().length<2}>{busy?'Поиск…':'Найти'}</button></form>
    <div className="mediaGalleryTabs" role="tablist">{[['all','Все'],['people','Люди'],['channels','Каналы'],['messages','Сообщения'],['media','Медиа'],['files','Файлы'],['links','Ссылки']].map(([id,label])=><button role="tab" aria-selected={tab===id} className={tab===id?'active':''} key={id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    {error && <div className="errorBox" role="alert">{error}</div>}
    <div className="globalSearchResults" aria-busy={busy}>
      {['all','channels'].includes(tab) && chats.length>0 && <><h3>Чаты и каналы</h3>{chats.map(chat=><button key={chat.id} onClick={()=>onNavigate(chat.id)}><b>{mark(chat.title)}</b><span>{chat.lastMessage || chat.publicUsername || ''}</span></button>)}</>}
      {['all','messages','media','files','links'].includes(tab) && messages.length>0 && <><h3>Сообщения и вложения</h3>{messages.map(message=><button key={message.id} onClick={()=>onNavigate(message.conversationId)}><b>{message.senderDisplayName}</b><span>{mark(message.body.slice(0,140) || message.attachment?.fileName || '')}</span></button>)}</>}
      {['all','people'].includes(tab) && results.users.length>0 && <><h3>Люди</h3>{results.users.map(user=><button key={user.id} onClick={()=>void openUser(user)}><b>{mark(user.displayName)}</b><span>@{user.username}</span></button>)}</>}
      {!busy && !chats.length && !messages.length && !results.users.length && <div className="emptySidebar"><Icon name="search" size={28} /><p>{searched?'Совпадений нет. Попробуй другое имя или слово.':'Введи хотя бы два символа, чтобы найти человека, чат или сообщение.'}</p></div>}
    </div>
  </section></Modal>;
}

function ChatPanel({ onBack, token, me, conversation, conversations, messages, setMessages, hasMoreMessages, setHasMoreMessages, connectionState, outboxCount, typingUsers, presence, socket, refreshConversations, api, onStartCall, onJoinVoiceRoom, voiceRoomConversationId }: {
  onBack: () => void;
  token: string;
  me: User;
  conversation: Conversation | null;
  conversations: Conversation[];
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  hasMoreMessages: boolean;
  setHasMoreMessages: Dispatch<SetStateAction<boolean>>;
  connectionState: 'connecting' | 'online' | 'reconnecting' | 'offline';
  outboxCount: number;
  typingUsers: Set<string>;
  presence: Record<string, boolean>;
  socket: WebSocket | null;
  refreshConversations: () => Promise<void>;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onStartCall: (conversation: Conversation, mode: CallMode) => Promise<void>;
  onJoinVoiceRoom: (conversation: Conversation, mode?: 'audio' | 'video') => Promise<void>;
  voiceRoomConversationId: string | null;
}) {
  const [draft, setDraft] = useState('');
  const [initialUnread] = useState(() => conversation?.unreadCount || 0);
  const [unreadAt,setUnreadAt] = useState<string|null>(null);
  useEffect(() => { if(initialUnread && !unreadAt && messages.length) { const incoming=messages.filter(message=>message.senderId!==me.id&&!message.deletedAt); if(incoming.length)setUnreadAt(incoming[Math.max(0,incoming.length-initialUnread)].id); } },[initialUnread,unreadAt,messages,me.id]);
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [queued, setQueued] = useState<OutboxItem[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  useEffect(() => { const update = () => setQueued(readOutbox(me.id).filter(item => item.conversationId === conversation?.id)); update(); window.addEventListener('messenger:outbox-changed', update); return () => window.removeEventListener('messenger:outbox-changed', update); }, [me.id, conversation?.id]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sharedFiles, setSharedFiles] = useState<File[]>([]);
  useEffect(() => { const receive = () => { const target = window as typeof window & { messengerSharedFiles?: File[] }; if (conversation?.id && target.messengerSharedFiles?.length) { setSharedFiles(target.messengerSharedFiles); target.messengerSharedFiles = []; } }; receive(); window.addEventListener('messenger:share-file', receive); return () => window.removeEventListener('messenger:share-file', receive); }, [conversation?.id]);
  const [failedUpload, setFailedUpload] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchSequence = useRef(0);
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [infoOpen, setInfoOpen] = useState(false);
  const [reactionFor, setReactionFor] = useState<string | null>(null);
  const [commentsFor, setCommentsFor] = useState<Message | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [miniAppUrl, setMiniAppUrl] = useState<string | null>(null);
  const [miniAppOpen, setMiniAppOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const draftSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftDirty = useRef(false);
  const draftVersion = useRef('');
  const editingRef = useRef(false);
  useEffect(() => { editingRef.current = !!editing; }, [editing]);
  const draftKey = `messenger_draft:${me.id}:${conversation?.id || 'none'}`;

  useEffect(() => {
    if (!conversation) return;
    let cancelled = false;
    setReplyTo(null); setEditing(null); setError('');
    const local = window.localStorage.getItem(`messenger_draft:${me.id}:${conversation.id}`) || '';
    setDraft(local);
    draftDirty.current = localStorage.getItem(`${draftKey}:dirty`) === '1';
    draftVersion.current = localStorage.getItem(`${draftKey}:updated`) || '';
    const applyCloud = (cloud: { body: string; updatedAt?: string; replyToId?: string | null }) => {
      if (cancelled || editingRef.current || draftDirty.current) return;
      if (cloud.updatedAt && cloud.updatedAt <= draftVersion.current) return;
      setDraft(cloud.body);
      if (cloud.body) localStorage.setItem(draftKey, cloud.body); else localStorage.removeItem(draftKey);
      draftVersion.current = cloud.updatedAt || new Date().toISOString();
      localStorage.setItem(`${draftKey}:updated`, draftVersion.current);
      setReplyTo(cloud.replyToId ? messages.find(message => message.id === cloud.replyToId) || null : null);
    };
    const replayLocal = () => {
      if (!draftDirty.current || editingRef.current) return;
      const body = localStorage.getItem(draftKey) || ''; const version = draftVersion.current;
      void api(`/drafts/${conversation.id}`, body ? { method: 'PUT', body: JSON.stringify({ body }) } : { method: 'DELETE' }).then(() => { if (version === draftVersion.current) { draftDirty.current = false; localStorage.removeItem(`${draftKey}:dirty`); } }).catch(() => {});
    };
    replayLocal(); window.addEventListener('online', replayLocal); window.addEventListener('messenger:resume', replayLocal);
    void api<{ drafts: { conversationId: string; body: string; replyToId: string | null; updatedAt: string }[] }>('/drafts').then(data => {
      const cloud = data.drafts.find(item => item.conversationId === conversation.id);
      if (cloud) applyCloud(cloud);
    }).catch(() => {});
    const sync = (event: Event) => {
      const detail = (event as CustomEvent).detail as { conversationId?: string; body?: string; updatedAt?: string; replyToId?: string | null };
      if (detail?.conversationId === conversation.id) applyCloud({ ...detail, body: String(detail.body || '') });
    };
    window.addEventListener('messenger:draft-sync', sync);
    return () => { cancelled = true; window.removeEventListener('messenger:draft-sync', sync); window.removeEventListener('online', replayLocal); window.removeEventListener('messenger:resume', replayLocal); };
    // Only initialize when the keyed conversation changes; message updates must not reload the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, conversation?.id, me.id]);
  useEffect(() => {
    const applyShare = (text: string) => {
      if (!conversation || !text) return;
      const current = localStorage.getItem(draftKey) || ''; const value = current ? `${current}\n${text}` : text;
      setDraft(value); localStorage.setItem(draftKey,value); localStorage.setItem(`${draftKey}:dirty`,'1'); draftDirty.current = true; draftVersion.current = new Date().toISOString(); localStorage.setItem(`${draftKey}:updated`,draftVersion.current);
      window.localStorage.removeItem('messenger_pending_share_text');
    };
    const pending = window.localStorage.getItem('messenger_pending_share_text');
    if (pending) applyShare(pending);
    const handler = (event: Event) => applyShare(String((event as CustomEvent).detail?.text || ''));
    window.addEventListener('messenger:share-text', handler);
    return () => window.removeEventListener('messenger:share-text', handler);
  }, [conversation, draftKey]);
  useEffect(() => { if (stickToBottom.current) endRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }, [messages, typingUsers, queued]);
  useEffect(() => () => { if (typingTimer.current) clearTimeout(typingTimer.current); if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current); if (mediaRecorderRef.current) { mediaRecorderRef.current.onstop = null; if (mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop(); } voiceStreamRef.current?.getTracks().forEach(t => t.stop()); }, []);
  useEffect(() => { setReplyTo(null); setEditing(null); setError(''); setSearchOpen(false); setSearchQuery(''); setSearchResults([]); setInfoOpen(false); setCommentsFor(null); setMiniAppOpen(false); setMediaOpen(false); }, [conversation?.id]);
  const botPeer = conversation?.kind === 'direct' ? conversation.members.find((member) => member.id !== me.id && member.isBot) : null;
  useEffect(() => {
    let cancelled = false;
    setMiniAppUrl(null);
    if (!botPeer?.username) return;
    void api<{ miniAppUrl: string | null }>(`/bots/${encodeURIComponent(botPeer.username)}/app`).then((data) => { if (!cancelled) setMiniAppUrl(data.miniAppUrl); }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, botPeer?.username, conversation?.id]);

  if (!conversation) {
    return (
      <section className="welcomePanel">
        <div className="welcomeIcon">✦</div><h2>Твой круг общения</h2>
        <p>Люди, идеи и важные моменты — в одном месте. Выбери чат или начни новую беседу.</p>
        <div className="featurePills"><span>Offline</span><span>History</span><span>Media</span><span>Deep Links</span></div>
      </section>
    );
  }

  const peer = conversation.members.find((member) => member.id !== me.id);
  const isTyping = conversation.members.some((member) => member.id !== me.id && typingUsers.has(member.id));
  const online = conversation.kind === 'direct' && peer && !conversation.blockedByMe && !conversation.blockedByOther ? presence[peer.id] : false;
  const messagingBlocked = conversation.kind === 'direct' && !conversation.isSaved && (conversation.blockedByMe || conversation.blockedByOther);
  const channelCanPost = conversation.kind !== 'channel' || conversation.myRole === 'owner' || conversation.myRole === 'admin';
  const composerDisabled = messagingBlocked || !channelCanPost;

  const notifyTyping = (active: boolean) => {
    if (conversation.isSaved || conversation.kind === 'channel' || messagingBlocked || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'typing', conversationId: conversation.id, active }));
  };

  const onDraftChange = (value: string) => {
    setDraft(value);
    if (!editing) {
      window.dispatchEvent(new Event('messenger:draft-changed'));
      draftDirty.current = true; localStorage.setItem(`${draftKey}:dirty`, '1'); draftVersion.current = new Date().toISOString(); localStorage.setItem(`${draftKey}:updated`, draftVersion.current);
      if (value) window.localStorage.setItem(draftKey, value); else window.localStorage.removeItem(draftKey);
      if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
      draftSyncTimer.current = setTimeout(() => {
        if (!conversation) return;
        const version = draftVersion.current;
        void api(`/drafts/${conversation.id}`, value ? { method: 'PUT', body: JSON.stringify({ body: value, replyToId: replyTo?.id || null }) } : { method: 'DELETE' }).then(() => { if (draftVersion.current === version) { draftDirty.current = false; localStorage.removeItem(`${draftKey}:dirty`); } }).catch(() => {});
      }, 450);
    }
    if (editing) return;
    notifyTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => notifyTyping(false), 900);
  };

  const startEdit = (message: Message) => {
    if (message.deletedAt) return;
    setReplyTo(null); setEditing(message); setDraft(message.body);
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 0);
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (messagingBlocked) { setError('Личные сообщения недоступны из-за блокировки.'); return; }
    if (!channelCanPost) { setError('Публиковать в канале могут только владелец и администраторы.'); return; }
    const body = draft.trim();
    if (editing) {
      if (!body && !editing.attachment) return;
      try {
        const data = await api<{ message: Message }>(`/messages/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
        setMessages((current) => current.map((m) => m.id === data.message.id ? data.message : m));
        setEditing(null); setDraft(''); window.dispatchEvent(new Event('messenger:draft-changed')); localStorage.removeItem(`${draftKey}:dirty`); draftDirty.current = false; draftVersion.current = new Date().toISOString(); localStorage.setItem(`${draftKey}:updated`, draftVersion.current); window.localStorage.removeItem(draftKey); void api(`/drafts/${conversation.id}`, { method: 'DELETE' }).catch(() => {}); await refreshConversations();
      } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка редактирования'); }
      return;
    }
    if (!body) return;
    const queuedItem: OutboxItem = { id: `msg_${crypto.randomUUID()}`, conversationId: conversation.id, body, replyToId: replyTo?.id || null, createdAt: new Date().toISOString(), attempts: 0 };
    try { enqueueOutbox(me.id, queuedItem); } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось сохранить сообщение'); return; }
    setDraft(''); window.dispatchEvent(new Event('messenger:draft-changed')); localStorage.removeItem(`${draftKey}:dirty`); draftDirty.current = false; draftVersion.current = new Date().toISOString(); localStorage.setItem(`${draftKey}:updated`, draftVersion.current); window.localStorage.removeItem(draftKey); notifyTyping(false); setError(''); setReplyTo(null); stickToBottom.current = true;
    if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
    void api(`/drafts/${conversation.id}`, { method: 'DELETE' }).catch(() => {});
    window.dispatchEvent(new Event('messenger:flush-outbox'));
  };

  const loadOlder = async () => {
    if (!hasMoreMessages || loadingOlder || !messages.length) return;
    setLoadingOlder(true);
    try {
      const before = btoa(JSON.stringify({ at: messages[0].createdAt, id: messages[0].id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const scroll = scrollRef.current; const oldHeight = scroll?.scrollHeight || 0; const oldTop = scroll?.scrollTop || 0; stickToBottom.current = false;
      const data = await api<{ messages: Message[]; hasMore: boolean }>(`/conversations/${conversation.id}/messages?limit=50&before=${encodeURIComponent(before)}`);
      setMessages((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...data.messages.filter((item) => !known.has(item.id)), ...current];
      });
      setHasMoreMessages(Boolean(data.hasMore));
      requestAnimationFrame(() => { if (scroll) scroll.scrollTop = oldTop + scroll.scrollHeight - oldHeight; });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить старые сообщения.');
    } finally {
      setLoadingOlder(false);
    }
  };

  const removeMessage = async (message: Message) => {
    if (!(await dialogs.confirm('Удалить сообщение для всех?'))) return;
    try {
      const data = await api<{ message: Message }>(`/messages/${message.id}`, { method: 'DELETE' });
      setMessages((current) => current.map((m) => m.id === message.id ? data.message : m));
      await refreshConversations();
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка удаления'); }
  };

  const forward = (message: Message) => {
    const targets = conversations.filter((item) => item.id !== conversation.id && !(item.kind === 'channel' && !['owner', 'admin'].includes(item.myRole)));
    if (!targets.length) { setError('Нет другого чата, куда можно переслать сообщение.'); return; }
    setForwarding(message);
  };

  const reportMessage = async (message: Message) => {
    const reasonRaw = (await dialogs.prompt('Причина: spam / harassment / violence / sexual / other', 'spam'));
    if (!reasonRaw) return;
    const details = (await dialogs.prompt('Комментарий к жалобе (необязательно)', '')) ?? '';
    try {
      await api('/reports', { method: 'POST', body: JSON.stringify({ targetUserId: message.senderId, conversationId: conversation.id, messageId: message.id, reason: reasonRaw.trim(), details }) });
      (await dialogs.alert('Жалоба на сообщение сохранена.'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отправить жалобу'); }
  };

  const react = async (message: Message, emoji: string) => {
    setReactionFor(null);
    try {
      const data = await api<{ message: Message }>(`/messages/${message.id}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) });
      setMessages((current) => current.map((item) => item.id === message.id ? data.message : item));
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка реакции'); }
  };

  const pin = async (messageId: string | null) => {
    try {
      await api(`/conversations/${conversation.id}/pin`, { method: 'POST', body: JSON.stringify({ messageId }) });
      await refreshConversations();
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка закрепления'); }
  };

  const searchMessages = async (value: string) => {
    const sequence = ++searchSequence.current; setSearchQuery(value);
    if (!value.trim()) { setSearchResults([]); return; }
    try {
      const data = await api<{ messages: Message[] }>(`/conversations/${conversation.id}/search?q=${encodeURIComponent(value.trim())}`);
      if (sequence === searchSequence.current) setSearchResults(data.messages);
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка поиска'); }
  };

  const toggleVoice = async () => {
    if (messagingBlocked) { setError('Личные сообщения недоступны из-за блокировки.'); return; }
    if (!channelCanPost) { setError('Публиковать в канале могут только администраторы.'); return; }
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }
    setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Запись голосовых не поддерживается этим браузером.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;
      voiceChunksRef.current = [];
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) voiceChunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const mime = recorder.mimeType || 'audio/webm';
        const blob = new Blob(voiceChunksRef.current, { type: mime });
        stream.getTracks().forEach((track) => track.stop());
        voiceStreamRef.current = null;
        mediaRecorderRef.current = null;
        if (!blob.size) return;
        const extension = mime.includes('ogg') ? 'ogg' : 'webm';
        void upload(new File([blob], `voice-${Date.now()}.${extension}`, { type: mime }));
      };
      recorder.start();
      setRecording(true);
    } catch (e) {
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
      voiceStreamRef.current = null;
      setRecording(false);
      setError(e instanceof Error ? e.message : 'Нет доступа к микрофону');
    }
  };

  const upload = async (file: File, albumId?: string, caption = draft.trim()) => {
    if (messagingBlocked || !channelCanPost) { setError('В этом чате нельзя отправить файл.'); return; }
    setUploading(true); setUploadProgress(0); setError(''); setFailedUpload(null);
    const key = `messenger_upload:${me.id}:${conversation.id}:${file.name}:${file.size}:${file.lastModified}`;
    albumId ||= localStorage.getItem(`${key}:album`) || undefined;
    if (albumId) localStorage.setItem(`${key}:album`,albumId);
    type Transfer = { expiresAt?: string; id: string; totalChunks: number; chunkSize: number; receivedChunks: number[]; status: string; mediaId?: string };
    try {
      if (!file.size || file.size > 512 * 1024 * 1024) throw new Error('Выбери непустой файл до 512 МБ.');
      let session: Transfer | null = null;
      const saved = window.localStorage.getItem(key);
      if (saved) try { session = (await api<{ upload: Transfer }>(`/uploads/${saved}/status`)).upload; if (!['uploading', 'completed'].includes(session.status) || (session.status !== 'completed' && session.expiresAt && Date.parse(session.expiresAt) <= Date.now())) session = null; } catch { session = null; }
      if (!session) session = (await api<{ upload: Transfer }>('/uploads/init', { method: 'POST', body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, chunkSize: 1024 * 1024 }) })).upload;
      window.localStorage.setItem(key, session.id);
      const received = new Set(session.receivedChunks || []);
      if (session.status !== 'completed') for (let index = 0; index < session.totalChunks; index++) {
        if (!received.has(index)) {
          const chunk = file.slice(index * session.chunkSize, Math.min(file.size, (index + 1) * session.chunkSize));
          let success = false;
          for (let retry = 0; retry < 3; retry++) {
            try {
              const response = await fetch(`${API_URL}/uploads/${session.id}/chunks/${index}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: chunk, signal: AbortSignal.timeout(45000) });
              if (!response.ok) { const payload = await response.json(); throw Object.assign(new Error(payload.message || 'Ошибка загрузки'), { status: response.status }); }
              success = true; break;
            } catch (error) { if ((error as { status?: number }).status || retry === 2) throw error; await new Promise(resolve => setTimeout(resolve, (retry + 1) * 500)); }
          }
          if (!success) throw new Error('Не удалось загрузить часть файла.');
        }
        setUploadProgress(Math.round((index + 1) / session.totalChunks * 100));
      }
      const completed = await api<{ media: Attachment }>(`/uploads/${session.id}/complete`, { method: 'POST' });
      enqueueOutbox(me.id, { id: `media_${session.id}`, conversationId: conversation.id, body: caption, replyToId: replyTo?.id || null, attachmentId: completed.media.id, albumId, createdAt: new Date().toISOString(), attempts: 0 });
      window.localStorage.removeItem(key); window.localStorage.removeItem(`${key}:album`); setDraft(''); window.dispatchEvent(new Event('messenger:draft-changed')); localStorage.removeItem(`${draftKey}:dirty`); draftDirty.current = false; draftVersion.current = new Date().toISOString(); localStorage.setItem(`${draftKey}:updated`, draftVersion.current); window.localStorage.removeItem(draftKey); setReplyTo(null);
      if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
      void api(`/drafts/${conversation.id}`, { method: 'DELETE' }).catch(() => {}); window.dispatchEvent(new Event('messenger:flush-outbox')); return true;
    } catch (error) { setFailedUpload(file); setError(`${error instanceof Error ? error.message : 'Ошибка загрузки'} Загрузка сохранена — можно продолжить.`); return false; }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  };

  return (
    <section className="chatPanel">
      <header className="chatHeader">
        <button className="mobileBack iconButton" aria-label="К списку чатов" onClick={onBack}><Icon name="back" /></button>
        <Avatar token={token} name={conversation.title} mediaId={conversation.avatarMediaId} className={`chatAvatar large ${conversation.isSaved ? 'savedAvatar' : ''}`} fallback={conversation.isSaved ? '★' : undefined} />
        <div className="chatIdentity">
          <strong>{conversation.title}</strong>
          <span className={online ? 'onlineText' : ''}>{connectionState !== 'online' ? (connectionState === 'offline' ? 'офлайн · сообщения попадут в исходящие' : 'переподключение…') : conversation.isSaved ? 'твои сообщения и файлы' : conversation.kind === 'channel' ? `${conversation.subscriberCount} подписчиков${conversation.publicUsername ? ` · @${conversation.publicUsername}` : ' · приватный'}` : messagingBlocked ? (conversation.blockedByMe ? 'пользователь заблокирован' : 'личные сообщения недоступны') : isTyping ? 'печатает…' : conversation.kind === 'group' ? `${conversation.members.length} участников` : online ? 'в сети' : conversation.username ? `@${conversation.username}` : 'чат'}</span>
        </div>
        <div className="headerActions">{conversation.kind === 'direct' && !conversation.isSaved && peer && !peer.isBot && !messagingBlocked && <><button title="Аудиозвонок" onClick={() => void onStartCall(conversation, 'audio')}><Icon name="phone" /></button><button title="Видеозвонок" onClick={() => void onStartCall(conversation, 'video')}><Icon name="video" /></button></>}{conversation.kind === 'group' && <><button className={voiceRoomConversationId === conversation.id ? 'voiceRoomActiveButton' : ''} title="Голосовая комната" onClick={() => void onJoinVoiceRoom(conversation, 'audio')}>♬</button><button className={voiceRoomConversationId === conversation.id ? 'voiceRoomActiveButton' : ''} title="Групповая видеокомната" onClick={() => void onJoinVoiceRoom(conversation, 'video')}>▣</button></>}{miniAppUrl && <button title="Открыть Mini App" onClick={() => setMiniAppOpen(true)}>▣</button>}<button title="Медиа и файлы" onClick={() => setMediaOpen(true)}><Icon name="gallery" /></button><button title="Поиск" onClick={() => setSearchOpen((value) => !value)}><Icon name="search" /></button><button title="Информация" onClick={() => setInfoOpen(true)}><Icon name="more" /></button></div>
      </header>

      {!!selectedMessages.size && <div className="selectionToolbar" role="toolbar" aria-label="Выбранные сообщения"><b>Выбрано: {selectedMessages.size}</b><button onClick={() => { const text = messages.filter(item => selectedMessages.has(item.id)).map(item => item.body).join('\n'); void navigator.clipboard.writeText(text).catch(() => setError('Копирование недоступно.')); }}>Копировать</button><button disabled={messages.some(item => selectedMessages.has(item.id) && item.senderId !== me.id)} onClick={async () => { if (!await dialogs.confirm(`Удалить ${selectedMessages.size} сообщений?`)) return; try { for (const id of selectedMessages) await api(`/messages/${id}`, { method:'DELETE' }); setMessages(current => current.map(item => selectedMessages.has(item.id) ? {...item,body:'',attachment:null,deletedAt:new Date().toISOString()} : item)); setSelectedMessages(new Set()); } catch(error) { setError(error instanceof Error ? error.message : 'Не удалось удалить сообщения'); } }}>Удалить</button><button aria-label="Отменить выбор" onClick={() => setSelectedMessages(new Set())}><Icon name="close" /></button></div>}
      {messagingBlocked && <div className="privacyBanner">{conversation.blockedByMe ? 'Ты заблокировал этого пользователя. Разблокируй его в информации о чате, чтобы снова писать.' : 'Этот пользователь ограничил личное общение.'}</div>}
      {conversation.kind === 'channel' && !channelCanPost && <div className="channelBanner">Ты подписчик этого канала. Публиковать посты могут только владелец и администраторы.</div>}
      {outboxCount > 0 && <div className="outboxBanner">Исходящие: <b>{outboxCount}</b> · {connectionState === 'online' ? 'отправка и повторные попытки' : 'отправятся после восстановления сети'}</div>}
      {conversation.pinnedMessage && <button className="pinnedBar" onClick={() => document.getElementById(`message-${conversation.pinnedMessage?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><b>Закреплено</b><span>{conversation.pinnedMessage.senderDisplayName}: {conversation.pinnedMessage.body}</span><i onClick={(e) => { e.stopPropagation(); void pin(null); }}>×</i></button>}
      {searchOpen && <div className="chatSearch"><input autoFocus value={searchQuery} onChange={(e) => void searchMessages(e.target.value)} placeholder="Поиск по сообщениям" /><button onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }}>×</button>{searchQuery && <div className="searchResults">{searchResults.length ? searchResults.map((result) => <button key={result.id} onClick={() => document.getElementById(`message-${result.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><b>{result.senderDisplayName}</b><span>{result.body}</span><time>{formatListTime(result.createdAt)}</time></button>) : <div>Ничего не найдено</div>}</div>}</div>}

      <div className="messagesArea" ref={scrollRef} onScroll={e => { const node = e.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
        {hasMoreMessages && <button className="loadOlderButton" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? 'Загрузка…' : 'Загрузить более ранние сообщения'}</button>}

        {messages.length === 0 && <div className="conversationStart">{conversation.isSaved ? 'Сохраняй здесь заметки, фотографии и файлы.' : conversation.kind === 'channel' ? <>В канале <b>{conversation.title}</b> пока нет публикаций.</> : <>Это начало вашей переписки с <b>{conversation.title}</b>.</>}</div>}
        {messages.map((message, index) => {
          const mine = message.senderId === me.id;
          const previous = messages[index - 1];
          const newDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
          const grouped = !newDay && previous?.senderId === message.senderId && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 120000;
          return (
            <div className={`messageGroup ${message.albumId && message.attachment && !message.deletedAt ? 'albumItem' : ''} ${message.albumId && message.albumId === previous?.albumId ? 'albumContinuation' : ''}`} data-album={message.albumId || undefined} key={message.id}>
            {unreadAt === message.id && <div className="unreadSeparator" role="separator">Непрочитанные сообщения</div>}
            {newDay && <div className="dateChip">{new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(message.createdAt))}</div>}
            <div id={`message-${message.id}`} className={`messageRow ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''} ${selectedMessages.has(message.id) ? 'messageSelected' : ''}`}>
              {!mine && !grouped ? <Avatar token={token} name={message.senderDisplayName} mediaId={conversation.members.find((member) => member.id === message.senderId)?.avatarMediaId || null} className="miniAvatar" /> : !mine ? <div className="miniAvatar spacer" /> : null}
              <div className={`bubbleWrap ${message.deletedAt ? 'deleted' : ''}`}>
                {!message.deletedAt && <div className="messageActions">
                  <button title={selectedMessages.has(message.id) ? 'Снять выбор' : 'Выбрать сообщение'} onClick={() => setSelectedMessages(current => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}><Icon name="check" size={16} /></button>
                  <button title="Ответить" onClick={() => { setEditing(null); setReplyTo(message); }}><Icon name="reply" size={16} /></button>
                  <button title="Переслать" onClick={() => forward(message)}><Icon name="forward" size={16} /></button>
                  <button title="Реакция" onClick={() => setReactionFor((id) => id === message.id ? null : message.id)}><Icon name="smile" size={16} /></button>
                  {!conversation.isSaved && (conversation.kind !== 'channel' || channelCanPost) && <button title="Закрепить" onClick={() => void pin(message.id)}><Icon name="pin" size={16} /></button>}
                  {!mine && !conversation.isSaved && <button title="Пожаловаться" onClick={() => void reportMessage(message)}>!</button>}
                  {mine && <button title="Редактировать" onClick={() => startEdit(message)}><Icon name="edit" size={16} /></button>}
                  {mine && <button title="Удалить" onClick={() => removeMessage(message)}><Icon name="trash" size={16} /></button>}
                </div>}
                {reactionFor === message.id && <div className="reactionPicker">{['👍','❤️','🔥','😂','😮','😢'].map((emoji) => <button key={emoji} onClick={() => void react(message, emoji)}>{emoji}</button>)}</div>}
                <div className="bubble">
                  {!mine && !grouped && <b className="senderName">{message.senderDisplayName}</b>}
                  {message.forwardedFrom && <div className="forwardedLabel">↗ Переслано от <b>{message.forwardedFrom.senderDisplayName}</b></div>}
                  {message.replyTo && <div className="replyQuote"><b>{message.replyTo.senderDisplayName}</b><span>{message.replyTo.body}</span></div>}
                  {message.deletedAt ? <span className="deletedText">Сообщение удалено</span> : <>
                    {message.attachment && <MediaAttachment token={token} attachment={message.attachment} />}
                    {message.body && <span>{renderMessageText(message.body, me.username)}</span>}
                  </>}
                  <time>{formatMessageTime(message.createdAt)}{message.editedAt ? ' · изм.' : ''}{mine && !conversation.isSaved ? (message.readByOther ? '  ✓✓' : '  ✓') : ''}</time>
                </div>
                {!message.deletedAt && message.reactions.length > 0 && <div className="reactionRow">{message.reactions.map((reaction) => <button key={reaction.emoji} className={reaction.mine ? 'mineReaction' : ''} onClick={() => void react(message, reaction.emoji)}>{reaction.emoji} <b>{reaction.count}</b></button>)}</div>}
                {!message.deletedAt && conversation.kind === 'channel' && <div className="channelPostMeta"><span>◉ {message.viewsCount}</span><button onClick={() => setCommentsFor(message)}>💬 {message.commentsCount}</button></div>}
              </div>
            </div></div>
          );
        })}
        {queued.map(item => <div className="messageRow mine pendingMessage" key={item.id}><div className="bubbleWrap"><div className="bubble"><span>{item.body || 'Вложение'}</span><time>{item.failed ? 'Не отправлено' : item.attempts ? 'Повторяем…' : 'В очереди'} · {formatMessageTime(item.createdAt)}</time></div>{item.lastError && <small className="pendingError">{item.lastError}</small>}<div className="pendingActions"><button onClick={() => { writeOutbox(me.id, readOutbox(me.id).map(entry => entry.id === item.id ? { ...entry, failed: false, lastError: undefined } : entry)); window.dispatchEvent(new Event('messenger:flush-outbox')); }}>Повторить</button><button onClick={() => writeOutbox(me.id, readOutbox(me.id).filter(entry => entry.id !== item.id))}>Удалить</button></div></div></div>)}
        {conversation.kind !== 'channel' && isTyping && <div className="typingBubble"><i /><i /><i /></div>}
        <div ref={endRef} />
      </div>

      <div className="composerStack">
        {error && <div className="composerError" role="alert">{error}</div>}
        {failedUpload && <div className="uploadRetry"><span>{failedUpload.name}</span><button disabled={uploading} onClick={() => void upload(failedUpload)}>Продолжить загрузку</button><button onClick={() => setFailedUpload(null)}>Закрыть</button></div>}
        {sharedFiles.length > 0 && <div className="uploadRetry"><span>Файлов из другого приложения: {sharedFiles.length}</span><button disabled={uploading} onClick={async () => { const files = [...sharedFiles]; setSharedFiles([]); for (const file of files) await upload(file); }}>Отправить сюда</button><button onClick={() => setSharedFiles([])}>Отмена</button></div>}
        {uploading && <div className="uploadProgress"><span>Загрузка · {uploadProgress}%</span><progress max={100} value={uploadProgress} /></div>}
        {(replyTo || editing) && <div className="composeContext">
          <div><b>{editing ? 'Редактирование' : `Ответ: ${replyTo?.senderDisplayName}`}</b><span>{editing ? editing.body : replyTo?.body || 'Вложение'}</span></div>
          <button onClick={() => { setReplyTo(null); setEditing(null); setDraft(''); }}>×</button>
        </div>}
        {emojiOpen && <div className="composerEmoji">{['😊','❤️','👍','🔥','😂','✨','🎉','👋','🤔','💙','🙏','🚀'].map(emoji => <button key={emoji} aria-label={`Добавить ${emoji}`} onClick={() => { onDraftChange(draft + emoji); setEmojiOpen(false); }}>{emoji}</button>)}</div>}
        <form className="composer" onSubmit={send}>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const files = Array.from(e.target.files || []).slice(0,10); const album = files.length > 1 && files.every(file => /^(image|video)\//.test(file.type)) ? `album_${crypto.randomUUID()}` : undefined; void (async () => { for (let i=0;i<files.length;i++) if (!await upload(files[i],album,i===0?draft.trim():'')) break; })(); }} />
          <button type="button" className="composerIcon" onClick={() => fileInput.current?.click()} disabled={uploading || composerDisabled} title="Отправить файл">{uploading ? `${uploadProgress}%` : <Icon name="clip" />}</button>
          <button type="button" className="composerIcon" aria-label="Эмодзи" onClick={() => setEmojiOpen(value => !value)} disabled={composerDisabled}><Icon name="smile" /></button>
          <textarea value={draft} aria-label="Сообщение" maxLength={8000} onChange={(e) => { onDraftChange(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`; }} onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); }
          }} placeholder={!channelCanPost ? 'Только администраторы могут публиковать' : messagingBlocked ? 'Личные сообщения недоступны' : recording ? 'Записывается голосовое…' : editing ? 'Изменить сообщение' : conversation.kind === 'channel' ? 'Новая публикация' : 'Сообщение'} rows={1} disabled={recording || composerDisabled} />
          {!draft.trim() && !editing && <button type="button" className={`voiceButton ${recording ? 'recording' : ''}`} onClick={() => void toggleVoice()} disabled={composerDisabled} title={recording ? 'Остановить запись' : 'Голосовое сообщение'}>{recording ? '■' : <Icon name="mic" />}</button>}
          {!editing && <button type="button" className="scheduleButton" onClick={() => setScheduledOpen(true)} disabled={composerDisabled} title="Запланированные сообщения"><Icon name="clock" /></button>}
          {(draft.trim() || editing) && <button type="submit" className={`sendButton ${draft.trim() ? 'ready' : ''}`} aria-label="Отправить">{editing ? '✓' : <Icon name="send" />}</button>}
        </form>
      </div>
      {mediaOpen && <MediaGalleryModal token={token} conversation={conversation} api={api} onClose={() => setMediaOpen(false)} />}
      {scheduledOpen && <ScheduledMessagesModal conversation={conversation} initialBody={draft} replyToId={replyTo?.id || null} api={api} onScheduled={() => { setDraft(''); window.dispatchEvent(new Event('messenger:draft-changed')); localStorage.removeItem(`${draftKey}:dirty`); draftDirty.current = false; draftVersion.current = new Date().toISOString(); localStorage.setItem(`${draftKey}:updated`, draftVersion.current); window.localStorage.removeItem(draftKey); setReplyTo(null); }} onClose={() => setScheduledOpen(false)} />}
      {forwarding && <ForwardModal message={forwarding} currentConversationId={conversation.id} conversations={conversations} api={api} onForwarded={async () => { setForwarding(null); await refreshConversations(); }} onClose={() => setForwarding(null)} />}
      {miniAppOpen && miniAppUrl && botPeer && <MiniAppModal bot={botPeer} url={miniAppUrl} onClose={() => setMiniAppOpen(false)} />}
      {infoOpen && <ChatInfoModal token={token} me={me} conversation={conversation} api={api} onChanged={async () => { await refreshConversations(); }} onClose={() => setInfoOpen(false)} />}
      {commentsFor && conversation.kind === 'channel' && <ChannelCommentsModal me={me} channel={conversation} post={commentsFor} api={api} onPostUpdated={(updated) => setMessages((current) => current.map((item) => item.id === updated.id ? updated : item))} onClose={() => setCommentsFor(null)} />}
    </section>
  );
}


type ScheduledMessage = { id: string; conversationId: string; body: string; replyToId: string | null; attachmentId: string | null; sendAt: string; createdAt: string; status: string };

function ScheduledMessagesModal({ conversation, initialBody, replyToId, api, onScheduled, onClose }: {
  conversation: Conversation;
  initialBody: string;
  replyToId: string | null;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onScheduled: () => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const [sendAt, setSendAt] = useState(() => { const date = new Date(Date.now() + 10 * 60_000); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); });
  const [items, setItems] = useState<ScheduledMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { const data = await api<{ scheduled: ScheduledMessage[] }>(`/scheduled?conversationId=${encodeURIComponent(conversation.id)}`); setItems(data.scheduled); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить отложенные сообщения.'); }
  }, [api, conversation.id]);
  useEffect(() => { void load(); }, [load]);
  const schedule = async (event: FormEvent) => {
    event.preventDefault(); const text = body.trim(); if (!text) return;
    setBusy(true); setError('');
    try {
      await api('/scheduled', { method: 'POST', body: JSON.stringify({ conversationId: conversation.id, body: text, replyToId, sendAt: new Date(sendAt).toISOString() }) });
      setBody(''); onScheduled(); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось запланировать сообщение.'); }
    finally { setBusy(false); }
  };
  const cancel = async (id: string) => { try { await api(`/scheduled/${id}`, { method: 'DELETE' }); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отменить сообщение.'); } };
  const editScheduled = async (item: ScheduledMessage) => { const nextBody = (await dialogs.prompt('Текст сообщения', item.body)) ?? item.body; const current = new Date(item.sendAt); const local = new Date(current.getTime() - current.getTimezoneOffset() * 60000).toISOString().slice(0, 16); const nextAt = (await dialogs.prompt('Время YYYY-MM-DDTHH:mm', local)); if (!nextAt) return; try { await api(`/scheduled/${item.id}`, { method: 'PATCH', body: JSON.stringify({ body: nextBody, sendAt: new Date(nextAt).toISOString() }) }); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить сообщение.'); } };
  return <Modal onClose={onClose}>
    <section className="compactModal scheduledModal">
      <header><div><span className="eyebrow">SCHEDULED</span><h2>Отложенная отправка</h2></div><button onClick={onClose}>×</button></header>
      <form className="scheduledForm" onSubmit={schedule}><textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} rows={3} placeholder="Сообщение…" /><div className="scheduledFormRow"><input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} /><button className="primaryButton" disabled={busy || !body.trim()}>Запланировать</button></div></form>
      {error && <div className="errorBox">{error}</div>}
      <div className="scheduledList">{items.length ? items.map((item) => <div className="scheduledCard" key={item.id}><div><b>{item.body || 'Вложение'}</b><span>{new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.sendAt))}</span></div><div className="scheduledActions"><button onClick={() => void editScheduled(item)}>Изменить</button><button onClick={() => void cancel(item.id)}>Отменить</button></div></div>) : <div className="emptySidebar">В этом чате нет запланированных сообщений.</div>}</div>
    </section>
  </Modal>;
}

function MiniAppModal({ bot, url, onClose }: { bot: User; url: string; onClose: () => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { const timer = window.setTimeout(() => setState(current => current === 'loading' ? 'failed' : current), 15000); return () => clearTimeout(timer); }, [attempt]);
  return <Modal onClose={onClose}>
    <section className="miniAppWindow">
      <header><div><b>{bot.displayName}</b><span>@{bot.username} · Mini App</span></div><button aria-label="Закрыть Mini App" onClick={onClose}><Icon name="close" /></button></header>
      {state !== 'ready' && <div className="emptySidebar" role="status">{state === 'loading' ? 'Загружаем приложение…' : <><p>Приложение не ответило. Сервер может быть недоступен или запрещать встраивание.</p><button onClick={() => { setState('loading'); setAttempt(value => value + 1); }}>Повторить</button></>}</div>}
      <iframe key={attempt} src={url} title={`${bot.displayName} Mini App`} sandbox="allow-forms allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'" onLoad={() => setState('ready')} onError={() => setState('failed')} />
      <footer><span>Приложение не имеет доступа к данным аккаунта.</span><a href={url} target="_blank" rel="noopener noreferrer">Открыть отдельно ↗</a></footer>
    </section>
  </Modal>;
}

function ForwardModal({ message, currentConversationId, conversations, api, onForwarded, onClose }: {
  message: Message;
  currentConversationId: string;
  conversations: Conversation[];
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onForwarded: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const targets = conversations.filter((item) => item.id !== currentConversationId && !(item.kind === 'channel' && !['owner', 'admin'].includes(item.myRole)));
  const filtered = targets.filter((item) => `${item.title} ${item.username || ''} ${item.publicUsername || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const send = async (target: Conversation) => {
    setBusyId(target.id); setError('');
    try {
      await api(`/messages/${message.id}/forward`, { method: 'POST', body: JSON.stringify({ conversationId: target.id }) });
      await onForwarded();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось переслать сообщение'); }
    finally { setBusyId(null); }
  };
  return <Modal onClose={onClose}>
    <section className="compactModal forwardModal">
      <header><div><span className="eyebrow">FORWARD</span><h2>Переслать сообщение</h2></div><button onClick={onClose}>×</button></header>
      <div className="forwardPreview">{message.body || (message.attachment ? `📎 ${message.attachment.fileName}` : 'Сообщение')}</div>
      <input className="modalSearch" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти чат" />
      {error && <div className="errorBox">{error}</div>}
      <div className="forwardTargets">{filtered.length ? filtered.map((chat) => <button key={chat.id} disabled={Boolean(busyId)} onClick={() => void send(chat)}><span className="forwardTargetIcon">{chat.kind === 'channel' ? '◉' : chat.kind === 'group' ? '◆' : chat.isSaved ? '★' : '●'}</span><div><b>{chat.title}</b><span>{chat.kind === 'channel' ? 'Канал' : chat.kind === 'group' ? 'Группа' : chat.username ? `@${chat.username}` : 'Личный чат'}</span></div>{busyId === chat.id && <i>…</i>}</button>) : <div className="emptySidebar">Ничего не найдено.</div>}</div>
    </section>
  </Modal>;
}

function ActivityModal({ api, onUnread, onNavigate, onClose }: {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onUnread: (count: number) => void;
  onNavigate: (conversationId: string, messageId: string | null) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await api<{ activities: Activity[]; unread: number }>('/activity?limit=80');
      setItems(data.activities); onUnread(data.unread);
      if (data.unread > 0) { await api('/activity/read', { method: 'POST' }); onUnread(0); setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() }))); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить активность'); }
    finally { setLoading(false); }
  }, [api, onUnread]);
  useEffect(() => { void load(); }, [load]);
  const label = (item: Activity) => item.type === 'mention' ? 'упомянул тебя' : item.type === 'reply' ? 'ответил на твоё сообщение' : item.type === 'reaction' ? `поставил реакцию ${String(item.payload.emoji || '')}` : item.type === 'channel_comment' ? 'прокомментировал публикацию' : 'новое событие';
  return <Modal onClose={onClose}>
    <section className="compactModal activityModal">
      <header><div><span className="eyebrow">ACTIVITY</span><h2>Активность</h2></div><button onClick={onClose}>×</button></header>
      {error && <div className="errorBox">{error}</div>}
      <div className="activityList">{loading ? <div className="emptySidebar">Загрузка…</div> : items.length ? items.map((item) => <button key={item.id} className={item.readAt ? '' : 'unread'} onClick={() => item.conversationId && onNavigate(item.conversationId, item.messageId)}><div className="activityGlyph">{item.type === 'mention' ? '@' : item.type === 'reply' ? '↩' : item.type === 'reaction' ? '♡' : '💬'}</div><div><p><b>{item.actor?.displayName || 'Система'}</b> {label(item)}</p><span>{item.conversationTitle || 'Чат'}{item.messagePreview ? ` · ${item.messagePreview.slice(0, 90)}` : ''}</span><time>{formatRelative(item.createdAt)}</time></div></button>) : <div className="emptySidebar">Здесь появятся упоминания, ответы, реакции и комментарии.</div>}</div>
    </section>
  </Modal>;
}

function ChannelCommentsModal({ me, channel, post, api, onPostUpdated, onClose }: {
  me: User;
  channel: Conversation;
  post: Message;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onPostUpdated: (message: Message) => void;
  onClose: () => void;
}) {
  const [comments, setComments] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const data = await api<{ comments: Message[] }>(`/channels/${channel.id}/posts/${post.id}/comments`);
      setComments(data.comments);
      const fresh = await api<{ message: Message }>(`/messages/${post.id}`);
      onPostUpdated(fresh.message);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить комментарии'); }
  }, [api, channel.id, onPostUpdated, post.id]);
  useEffect(() => { void load(); }, [load]);
  const sendComment = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setError('');
    try {
      const data = await api<{ comment: Message }>(`/channels/${channel.id}/posts/${post.id}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
      setComments((current) => [...current, data.comment]); setDraft('');
      const fresh = await api<{ message: Message }>(`/messages/${post.id}`); onPostUpdated(fresh.message);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отправить комментарий'); }
    finally { setBusy(false); }
  };
  return <Modal onClose={onClose}>
    <section className="settingsModal commentsModal">
      <header><div><span className="eyebrow">COMMENTS</span><h2>{channel.title}</h2></div><button onClick={onClose}>×</button></header>
      <div className="commentPostPreview"><b>{post.senderDisplayName}</b><span>{post.body || (post.attachment ? `📎 ${post.attachment.fileName}` : 'Публикация')}</span><small>◉ {post.viewsCount} · 💬 {post.commentsCount}</small></div>
      {error && <div className="errorBox">{error}</div>}
      <div className="commentsList">{comments.length ? comments.map((comment) => <div className={`commentCard ${comment.senderId === me.id ? 'mineComment' : ''}`} key={comment.id}><b>{comment.senderDisplayName}</b><span>{comment.deletedAt ? 'Комментарий удалён' : comment.body}</span><time>{formatMessageTime(comment.createdAt)}</time></div>) : <div className="muted commentEmpty">Комментариев пока нет. Начни обсуждение.</div>}</div>
      <form className="commentComposer" onSubmit={sendComment}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={8000} placeholder="Комментарий…" rows={2} /><button className="primaryButton" disabled={busy || !draft.trim()}>Отправить</button></form>
    </section>
  </Modal>;
}

function ChatInfoModal({ token, me, conversation, api, onChanged, onClose }: {
  token: string;
  me: User;
  conversation: Conversation;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteData, setInviteData] = useState<{ token: string; createdAt: string; expiresAt: string | null; uses: number } | null>(null);
  const peer = conversation.members.find((member) => member.id !== me.id);
  const canAdmin = conversation.myRole === 'owner' || conversation.myRole === 'admin';

  useEffect(() => {
    if (!['group', 'channel'].includes(conversation.kind) || !canAdmin) return;
    void api<{ invite: { token: string; createdAt: string; expiresAt: string | null; uses: number } | null }>(`/conversations/${conversation.id}/invite`)
      .then((data) => setInviteData(data.invite)).catch(() => {});
  }, [api, canAdmin, conversation.id, conversation.kind]);

  const invite = async () => {
    const username = (await dialogs.prompt('Username нового участника, например @alex'));
    if (!username) return;
    setBusy(true); setError('');
    try {
      await api(`/conversations/${conversation.id}/members`, { method: 'POST', body: JSON.stringify({ username }) });
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось добавить участника'); }
    finally { setBusy(false); }
  };

  const rename = async () => {
    const title = (await dialogs.prompt('Новое название группы', conversation.title));
    if (!title || title === conversation.title) return;
    setBusy(true); setError('');
    try {
      await api(`/conversations/${conversation.id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось переименовать группу'); }
    finally { setBusy(false); }
  };

  const setRole = async (member: User, role: 'admin' | 'member') => {
    setBusy(true); setError('');
    try {
      await api(`/conversations/${conversation.id}/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ role }) });
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить роль'); }
    finally { setBusy(false); }
  };

  const remove = async (member: User) => {
    if (!(await dialogs.confirm(member.id === me.id ? 'Покинуть группу?' : `Удалить ${member.displayName} из группы?`))) return;
    setBusy(true); setError('');
    try {
      await api(`/conversations/${conversation.id}/members/${member.id}`, { method: 'DELETE' });
      await onChanged();
      if (member.id === me.id) onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось удалить участника'); }
    finally { setBusy(false); }
  };

  const toggleMute = async () => {
    setBusy(true); setError('');
    try {
      await api(`/conversations/${conversation.id}/notifications`, { method: 'PATCH', body: JSON.stringify({ muted: !conversation.muted }) });
      if (conversation.muted && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить уведомления'); }
    finally { setBusy(false); }
  };

  const createInviteLink = async () => {
    setBusy(true); setError('');
    try {
      const data = await api<{ invite: { token: string; createdAt: string; expiresAt: string | null; uses: number } }>(`/conversations/${conversation.id}/invite`, { method: 'POST', body: JSON.stringify({ hours: 24 * 7 }) });
      setInviteData(data.invite);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать ссылку'); }
    finally { setBusy(false); }
  };

  const revokeInviteLink = async () => {
    setBusy(true); setError('');
    try { await api(`/conversations/${conversation.id}/invite`, { method: 'DELETE' }); setInviteData(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отозвать ссылку'); }
    finally { setBusy(false); }
  };

  const blockPeer = async () => {
    if (!peer) return;
    setBusy(true); setError('');
    try {
      await api(`/users/${encodeURIComponent(peer.username)}/block`, { method: conversation.blockedByMe ? 'DELETE' : 'POST' });
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить блокировку'); }
    finally { setBusy(false); }
  };

  const reportPeer = async () => {
    if (!peer) return;
    const reasonRaw = (await dialogs.prompt('Причина: spam / harassment / violence / sexual / other', 'spam'));
    if (!reasonRaw) return;
    const details = (await dialogs.prompt('Комментарий к жалобе (необязательно)', '')) ?? '';
    setBusy(true); setError('');
    try {
      await api('/reports', { method: 'POST', body: JSON.stringify({ targetUserId: peer.id, conversationId: conversation.id, reason: reasonRaw.trim(), details }) });
      (await dialogs.alert('Жалоба сохранена.'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отправить жалобу'); }
    finally { setBusy(false); }
  };

  return <Modal onClose={onClose}>
    <section className="settingsModal chatInfoModal">
      <header><div><span className="eyebrow">{conversation.kind === 'channel' ? 'CHANNEL' : conversation.kind === 'group' ? 'GROUP' : 'PROFILE'}</span><h2>{conversation.title}</h2></div><button onClick={onClose}>×</button></header>
      <div className="profileHero">
        <Avatar token={token} name={conversation.title} mediaId={conversation.avatarMediaId} className="profileHeroAvatar" fallback={conversation.isSaved ? '★' : undefined} />
        <div><strong>{conversation.title}</strong><span>{conversation.kind === 'channel' ? `${conversation.subscriberCount} подписчиков · ${conversation.publicUsername ? `@${conversation.publicUsername}` : 'приватный'} · ${roleLabel(conversation.myRole)}` : conversation.kind === 'group' ? `${conversation.members.length} участников · твоя роль: ${roleLabel(conversation.myRole)}` : peer ? `@${peer.username}` : 'Saved Messages'}</span></div>
      </div>
      {peer && conversation.kind === 'direct' && <div className="profileBio">{peer.bio || 'Описание профиля пока не заполнено.'}</div>}
      {error && <div className="errorBox">{error}</div>}
      {!conversation.isSaved && <div className="infoActions"><button disabled={busy} onClick={() => void toggleMute()}>{conversation.muted ? '🔔 Включить уведомления' : '🔕 Выключить уведомления'}</button>{typeof Notification !== 'undefined' && Notification.permission !== 'granted' && <button disabled={busy} onClick={() => void Notification.requestPermission()}>Разрешить системные уведомления</button>}</div>}
      {peer && conversation.kind === 'direct' && <div className="privacyActions"><button disabled={busy} onClick={() => void blockPeer()}>{conversation.blockedByMe ? 'Разблокировать пользователя' : 'Заблокировать пользователя'}</button><button className="dangerMini" disabled={busy} onClick={() => void reportPeer()}>Пожаловаться</button></div>}
      {conversation.kind === 'channel' && <>
        <div className="profileBio">{conversation.description || 'У канала пока нет описания.'}</div>
        <div className="infoActions">
          {canAdmin && <button disabled={busy} onClick={async () => {
            const title = (await dialogs.prompt('Название канала', conversation.title)); if (!title) return;
            const description = (await dialogs.prompt('Описание канала', conversation.description || '')) ?? conversation.description;
            const username = (await dialogs.prompt('Публичный @username (пусто = приватный)', conversation.publicUsername || '')) ?? conversation.publicUsername;
            setBusy(true); setError(''); try { await api(`/channels/${conversation.id}`, { method: 'PATCH', body: JSON.stringify({ title, description, username }) }); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось обновить канал'); } finally { setBusy(false); }
          }}>✎ Настроить канал</button>}
          {conversation.myRole !== 'owner' && <button className="dangerMini" disabled={busy} onClick={async () => { if (!(await dialogs.confirm('Отписаться от канала?'))) return; setBusy(true); try { await api(`/channels/${conversation.id}/leave`, { method: 'DELETE' }); await onChanged(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось отписаться'); } finally { setBusy(false); } }}>Отписаться</button>}
        </div>
        {canAdmin && <div className="inviteCard"><div><b>{conversation.publicUsername ? 'Дополнительная invite-ссылка' : 'Invite-ссылка приватного канала'}</b><span>{inviteData ? `Использований: ${inviteData.uses} · до ${inviteData.expiresAt ? formatRelativeFuture(inviteData.expiresAt) : 'без срока'}` : 'Активной ссылки нет'}</span></div><div className="inviteActions">{inviteData ? <><button disabled={busy} onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/?invite=${inviteData.token}`)}>Копировать</button><button className="dangerMini" disabled={busy} onClick={() => void revokeInviteLink()}>Отозвать</button></> : <button disabled={busy} onClick={() => void createInviteLink()}>Создать на 7 дней</button>}</div></div>}
        <div className="channelStats"><div><b>{conversation.subscriberCount}</b><span>подписчиков</span></div><div><b>{conversation.publicUsername ? 'PUBLIC' : 'PRIVATE'}</b><span>тип канала</span></div><div><b>{conversation.discussionConversationId ? 'ON' : 'OFF'}</b><span>комментарии</span></div></div>
        {conversation.myRole === 'owner' && <><h3 className="settingsTitle">Администраторы и подписчики</h3><div className="memberList channelMemberList">{conversation.members.map((member) => <div className="memberCard" key={member.id}><Avatar token={token} name={member.displayName} mediaId={member.avatarMediaId} className="memberAvatar" /><div className="memberIdentity"><strong>{member.displayName}</strong><span>@{member.username} · {roleLabel(member.role || 'member')}</span></div><div className="memberActions">{member.id !== me.id && member.role !== 'owner' && <button disabled={busy} onClick={() => void setRole(member, member.role === 'admin' ? 'member' : 'admin')}>{member.role === 'admin' ? 'Снять админа' : 'Сделать админом'}</button>}</div></div>)}</div></>}
      </>}
      {conversation.kind === 'group' && <>
        <div className="infoActions">
          {canAdmin && <button disabled={busy} onClick={() => void invite()}>＋ Добавить участника</button>}
          {canAdmin && <button disabled={busy} onClick={() => void rename()}>✎ Переименовать</button>}
        </div>
        {canAdmin && <div className="inviteCard"><div><b>Invite-ссылка</b><span>{inviteData ? `Использований: ${inviteData.uses} · до ${inviteData.expiresAt ? formatRelativeFuture(inviteData.expiresAt) : 'без срока'}` : 'Активной ссылки нет'}</span></div><div className="inviteActions">{inviteData ? <><button disabled={busy} onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/?invite=${inviteData.token}`)}>Копировать</button><button className="dangerMini" disabled={busy} onClick={() => void revokeInviteLink()}>Отозвать</button></> : <button disabled={busy} onClick={() => void createInviteLink()}>Создать на 7 дней</button>}</div></div>}
        <div className="memberList">
          {conversation.members.map((member) => <div className="memberCard" key={member.id}>
            <Avatar token={token} name={member.displayName} mediaId={member.avatarMediaId} className="memberAvatar" />
            <div className="memberIdentity"><strong>{member.displayName}</strong><span>@{member.username} · {roleLabel(member.role || 'member')}</span></div>
            <div className="memberActions">
              {conversation.myRole === 'owner' && member.id !== me.id && member.role !== 'owner' && <button disabled={busy} onClick={() => void setRole(member, member.role === 'admin' ? 'member' : 'admin')}>{member.role === 'admin' ? 'Снять админа' : 'Сделать админом'}</button>}
              {member.id !== me.id && canAdmin && member.role !== 'owner' && !(conversation.myRole === 'admin' && member.role === 'admin') && <button className="dangerMini" disabled={busy} onClick={() => void remove(member)}>Удалить</button>}
            </div>
          </div>)}
        </div>
        {conversation.myRole !== 'owner' && <button className="dangerButton" disabled={busy} onClick={() => void remove(me)}>Покинуть группу</button>}
      </>}
    </section>
  </Modal>;
}

function MediaGalleryModal({ token, conversation, api, onClose }: {
  token: string;
  conversation: Conversation;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MediaGalleryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'media' | 'files' | 'links'>('all');
  const [links, setLinks] = useState<{ messageId: string; href: string; createdAt: string }[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async (before?: string | null, append = false) => {
    setLoading(true); setError('');
    try {
      const suffix = before ? `&before=${encodeURIComponent(before)}` : '';
      const data = await api<{ items: MediaGalleryItem[]; hasMore: boolean; nextCursor: string | null }>(`/conversations/${conversation.id}/media?limit=60${suffix}`);
      setItems((current) => append ? [...current, ...data.items] : data.items);
      setHasMore(Boolean(data.hasMore));
      setCursor(data.nextCursor);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить медиа.'); }
    finally { setLoading(false); }
  }, [api, conversation.id]);

  useEffect(() => { void load(null, false); void api<{ links: { messageId: string; href: string; createdAt: string }[] }>(`/conversations/${conversation.id}/links`).then((data) => setLinks(data.links)).catch(() => setLinks([])); }, [load, api, conversation.id]);

  const visible = items.filter((item) => {
    if (filter === 'media') return item.mimeType.startsWith('image/') || item.mimeType.startsWith('video/');
    if (filter === 'files') return !item.mimeType.startsWith('image/') && !item.mimeType.startsWith('video/');
    if (filter === 'links') return false;
    return true;
  });

  return <Modal onClose={onClose}>
    <section className="mediaGalleryModal">
      <header>
        <div><span className="eyebrow">SHARED MEDIA</span><h2>{conversation.title}</h2></div>
        <button onClick={onClose}>×</button>
      </header>
      <div className="mediaGalleryTabs">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Все</button>
        <button className={filter === 'media' ? 'active' : ''} onClick={() => setFilter('media')}>Фото и видео</button>
        <button className={filter === 'files' ? 'active' : ''} onClick={() => setFilter('files')}>Файлы</button>
        <button className={filter === 'links' ? 'active' : ''} onClick={() => setFilter('links')}>Ссылки</button>
      </div>
      {error && <div className="errorBox">{error}</div>}
      {filter === 'links' ? <div className="sharedLinksList">{links.length ? links.map((link) => <a key={`${link.messageId}:${link.href}`} href={link.href} target="_blank" rel="noreferrer"><b>{link.href}</b><span>{formatListTime(link.createdAt)}</span></a>) : <div className="emptySidebar">Ссылок пока нет.</div>}</div> : <div className="mediaGalleryGrid">
        {visible.map((item) => <div className="mediaGalleryCard" key={`${item.messageId}:${item.id}`}>
          <MediaAttachment token={token} attachment={{ id: item.id, fileName: item.fileName, mimeType: item.mimeType, size: item.size }} />
          <div className="mediaGalleryMeta"><b>{item.fileName}</b><span>{item.senderDisplayName} · {formatListTime(item.createdAt)}</span></div>
        </div>)}
        {!loading && visible.length === 0 && <div className="emptySidebar">В этом чате пока нет подходящих вложений.</div>}
      </div>}
      <footer>{hasMore && <button className="primaryButton" disabled={loading} onClick={() => void load(cursor, true)}>{loading ? 'Загрузка…' : 'Показать ещё'}</button>}</footer>
    </section>
  </Modal>;
}

function MediaAttachment({ token, attachment }: { token: string; attachment: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewer, setViewer] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false; let started = false;
    const controller = new AbortController();
    const load = async () => {
      if (started) return; started = true;
      try {
        const response = await fetch(`${API_URL}/media/${attachment.id}/access`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        if (!response.ok) throw new Error('media');
        const data = await response.json(); if (!cancelled) { setUrl(API_URL + data.path); setFailed(false); }
      } catch { if (!cancelled) setFailed(true); }
    };
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { void load(); observer.disconnect(); } }, { rootMargin: '200px' });
    if (ref.current) observer.observe(ref.current);
    return () => { cancelled = true; controller.abort(); observer.disconnect(); };
  }, [attachment.id, token, attempt]);
  const retry = () => { setUrl(null); setFailed(false); setAttempt(value => value + 1); };
  return <div ref={ref} className="attachmentContent">
    {failed ? <div className="fileCard"><Icon name="download" /><div><b>{attachment.fileName}</b><span>Файл недоступен</span></div><button className="secondaryButton" onClick={retry}>Повторить</button></div>
      : !url ? <div className="mediaLoading" role="status">Подготовка вложения…</div>
      : attachment.mimeType.startsWith('image/') ? <button className="imageOpenButton" aria-label={`Открыть ${attachment.fileName}`} onClick={() => setViewer(true)}><Image className="messageImage" src={url} alt={attachment.fileName} width={420} height={315} unoptimized onError={() => setFailed(true)} /></button>
      : attachment.mimeType.startsWith('video/') ? <video className="messageVideo" src={url} controls playsInline preload="metadata" onError={() => setFailed(true)} />
      : attachment.mimeType.startsWith('audio/') ? <audio className="messageAudio" src={url} controls preload="metadata" onError={() => setFailed(true)} />
      : <a className="fileCard" href={url} download={attachment.fileName}><div className="fileIcon"><Icon name="download" /></div><div><b>{attachment.fileName}</b><span>{formatBytes(attachment.size)} · Скачать</span></div></a>}
    {viewer && url && <Modal onClose={() => setViewer(false)}><section className="imageViewer"><header><h2>{attachment.fileName}</h2><a href={url} download={attachment.fileName} aria-label="Скачать"><Icon name="download" /></a><button aria-label="Закрыть" onClick={() => setViewer(false)}><Icon name="close" /></button></header><Image src={url} alt={attachment.fileName} width={1200} height={900} unoptimized /></section></Modal>}
  </div>;
}

function LoadingScreen() { return <main className="loading"><Brand /><div className="loader" /><span>Твоё пространство готовится…</span></main>; }
