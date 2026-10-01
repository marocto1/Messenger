export function renderMessageText(text: string, myUsername: string) {
  return text.split(/(https?:\/\/[^\s<>()]+|@[a-zA-Z0-9_]{3,24})/g).map((part, index) => part.startsWith('http://') || part.startsWith('https://') ? <a key={index} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : /^@/.test(part) ? <strong key={index} className={part.slice(1).toLowerCase() === myUsername.toLowerCase() ? 'mention me' : 'mention'}>{part}</strong> : part);
}
export function formatRelativeFuture(value: string) { const ms = new Date(value).getTime() - Date.now(); if (ms <= 0) return 'истекла'; const hours = Math.ceil(ms / 3600000); if (hours < 24) return `${hours} ч.`; return `${Math.ceil(hours / 24)} дн.`; }

export function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'; }
export function formatMessageTime(value: string) { return new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
export function formatListTime(value: string | null) { if (!value) return ''; const date = new Date(value); const now = new Date(); if (date.toDateString() === now.toDateString()) return formatMessageTime(value); return new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit' }).format(date); }
export function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} Б`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`; return `${(bytes / 1024 ** 2).toFixed(1)} МБ`; }
export function roleLabel(role: 'owner' | 'admin' | 'member') { return role === 'owner' ? 'владелец' : role === 'admin' ? 'администратор' : 'участник'; }
export function deviceIcon(ua: string) { return /android|iphone|mobile/i.test(ua) ? '▯' : '▰'; }
export function deviceName(ua: string) { if (/android/i.test(ua)) return 'Android'; if (/iphone|ipad/i.test(ua)) return 'iPhone / iPad'; if (/edg/i.test(ua)) return 'Microsoft Edge · Windows'; if (/chrome/i.test(ua)) return 'Chrome · Desktop'; if (/firefox/i.test(ua)) return 'Firefox · Desktop'; return 'Web session'; }
export function formatRelative(value: string) { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return 'только что'; if (seconds < 3600) return `${Math.floor(seconds / 60)} мин. назад`; if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч. назад`; return `${Math.floor(seconds / 86400)} дн. назад`; }
