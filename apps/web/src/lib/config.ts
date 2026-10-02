const browserOrigin = typeof window !== 'undefined' ? window.location.origin : '';
const browserWs = typeof window !== 'undefined'
  ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
  : '';

export const API_URL = process.env.NEXT_PUBLIC_API_URL
  || (browserOrigin ? `${browserOrigin}/api` : '')
  || 'http://localhost:4000';
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL
  || browserWs
  || 'ws://localhost:4000/ws';
export const RTC_ICE_SERVERS: RTCIceServer[] = (() => {
  const fallback: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const raw = process.env.NEXT_PUBLIC_RTC_ICE_SERVERS;
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as RTCIceServer[];
    return Array.isArray(parsed) && parsed.length ? parsed : fallback;
  } catch { return fallback; }
})();

let runtimeIceServers: RTCIceServer[] = RTC_ICE_SERVERS;
export function setIceServers(value: RTCIceServer[]) { if (Array.isArray(value) && value.length) runtimeIceServers = value; }
export function getIceServers() { return runtimeIceServers; }
