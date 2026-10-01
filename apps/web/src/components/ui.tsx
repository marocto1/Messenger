'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  check: <path d="m5 12 4 4L19 6"/>,
  chat: <><path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 10 10 0 0 1-4-.8L3 21l1.8-5a9 9 0 1 1 16.2-4.5Z"/><path d="M8 10h8M8 14h5"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  settings: <><path d="m9 3-1 3-3 1-2 3 2 3 3 1 1 3h6l1-3 3-1 2-3-2-3-3-1-1-3Z"/><circle cx="12" cy="10" r="3"/></>,
  phone: <path d="M8 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-4l-5-2-2 3a15 15 0 0 1-7-7l3-2-2-5Z"/>,
  video: <><rect x="3" y="5" width="12" height="14" rx="3"/><path d="m15 10 6-4v12l-6-4"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 8-3 8-3 9h18c0-1-3-1-3-9M10 21h4"/></>,
  plus: <path d="M12 4v16M4 12h16"/>,
  back: <path d="m14 5-7 7 7 7M7 12h14"/>,
  send: <><path d="m3 3 18 9-18 9 3-9-3-9ZM6 12h15"/></>,
  mic: <><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>,
  clip: <path d="m9 12 6-6a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2M6 15l9-9"/>,
  gallery: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-7 5 8"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></>,
  smile: <><circle cx="12" cy="12" r="9"/><path d="M8 14s1 3 4 3 4-3 4-3M8 9h.01M16 9h.01"/></>,
  reply: <path d="m9 4-6 6 6 6M3 10h10a8 8 0 0 1 8 8"/>,
  forward: <path d="m15 4 6 6-6 6M21 10H11a8 8 0 0 0-8 8"/>,
  pin: <path d="m9 3 9 9-4 1-3 5-5-5 5-3-2-7ZM8 16l-5 5"/>,
  edit: <><path d="m4 16 12-12 4 4L8 20l-5 1 1-5Z"/><path d="m14 6 4 4"/></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M3 17v4h18v-4"/></>,
  logout: <><path d="M10 3H4v18h6M9 12h12m-4-4 4 4-4 4"/></>,
};
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.more}</svg>;
}
export function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brandSymbol ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M7 29V11l13 12 13-12v18" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><path d="M20 9v5" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg></span>;
}
const focusable = 'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]';
export function Modal({ children, onClose, className = '', label = 'Диалог' }: { children: ReactNode; onClose: () => void; className?: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = ref.current!;
    const heading = root.querySelector('h2, h3, h1');
    if (heading) { heading.id ||= `dialog-${crypto.randomUUID()}`; root.setAttribute('aria-labelledby', heading.id); }
    root.querySelector<HTMLElement>('[autofocus]')?.focus();
    if (!root.contains(document.activeElement)) (root.querySelector<HTMLElement>(focusable) || root).focus();
    const keyboard = (e: KeyboardEvent) => {
      if (root !== document.querySelector('.modalBackdrop:last-of-type')) {
        const all = Array.from(document.querySelectorAll('.modalBackdrop'));
        if (all.at(-1) !== root) return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); }
      if (e.key !== 'Tab') return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(focusable)).filter(el => el.getClientRects().length);
      if (!items.length) { e.preventDefault(); root.focus(); return; }
      if (e.shiftKey && (document.activeElement === items[0] || document.activeElement === root)) { e.preventDefault(); items.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('keydown', keyboard, true); if (before?.isConnected) before.focus(); };
  }, []);
  return createPortal(<div ref={ref} className={`modalBackdrop ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>{children}</div>, document.body);
}

type DialogRequest = { text: string; initial: string; kind: 'prompt' | 'confirm' | 'alert'; resolve: (value: string | boolean | null) => void };
const dialogQueue: DialogRequest[] = [];
let notifyDialog: (() => void) | undefined;
function request(kind: DialogRequest['kind'], text: string, initial = '') { return new Promise<string | boolean | null>(resolve => { dialogQueue.push({ kind, text, initial, resolve }); notifyDialog?.(); }); }
export const dialogs = {
  prompt: async (text: string, initial = '') => await request('prompt', text, initial) as string | null,
  confirm: async (text: string) => await request('confirm', text) === true,
  alert: async (text: string) => { await request('alert', text); },
};
export function DialogHost() {
  const [item, setItem] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState('');
  const inputId = useId();
  useEffect(() => { notifyDialog = () => { const next = dialogQueue[0] || null; setItem(next); setValue(next?.initial || ''); }; notifyDialog(); return () => { notifyDialog = undefined; }; }, []);
  const finish = (result: string | boolean | null) => { dialogQueue.shift()?.resolve(result); notifyDialog?.(); };
  if (!item) return null;
  return <Modal onClose={() => finish(null)} className="inputDialogBackdrop" label={item.kind === 'prompt' ? 'Ввод данных' : 'Подтверждение'}><section className="compactModal inputDialog"><h2>{item.kind === 'prompt' ? 'Продолжить' : item.kind === 'alert' ? 'Готово' : 'Подтвердить действие'}</h2><form onSubmit={e => { e.preventDefault(); finish(item.kind === 'prompt' ? value : true); }}><label htmlFor={inputId}>{item.text}</label>{item.kind === 'prompt' && <input id={inputId} autoFocus value={value} onChange={e => setValue(e.target.value)} maxLength={8000}/>}<footer>{item.kind !== 'alert' && <button type="button" className="secondaryButton" onClick={() => finish(null)}>Отмена</button>}<button type="submit" className="primaryButton">{item.kind === 'prompt' ? 'Продолжить' : 'Подтвердить'}</button></footer></form></section></Modal>;
}
