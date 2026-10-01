'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { getIceServers } from '../lib/config';
import type { CallMode,CallQuality,CallSocketEvent,CallWire,Conversation,LiveCall,RoomSocketEvent,VoiceRoomWire } from '../lib/types';
import { Avatar } from './Avatar';
import { Icon,Modal } from './ui';
export function useCallController(socketRef: { current: WebSocket | null }) {
  const [call, setCall] = useState<LiveCall | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState('');
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [quality, setQuality] = useState<CallQuality>({ rttMs: null, jitterMs: null, packetLoss: null, bitrateKbps: null });
  const callRef = useRef<LiveCall | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryAttemptedRef = useRef(false);
  const statsRef = useRef<{ bytes: number; at: number } | null>(null);

  useEffect(() => { callRef.current = call; }, [call]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const send = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Realtime-соединение недоступно.');
    socket.send(JSON.stringify(payload));
  }, [socketRef]);

  const reset = useCallback((message?: string) => {
    if (recoveryTimerRef.current) { clearTimeout(recoveryTimerRef.current); recoveryTimerRef.current = null; }
    recoveryAttemptedRef.current = false;
    pcRef.current?.close();
    pcRef.current = null;
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    pendingIceRef.current = [];
    setLocalStream(null);
    setRemoteStream(null);
    setSharingScreen(false);
    setMicEnabled(true);
    setCameraEnabled(false);
    setCall(null);
    setQuality({ rttMs: null, jitterMs: null, packetLoss: null, bitrateKbps: null });
    statsRef.current = null;
    callRef.current = null;
    if (message) setNotice(message);
  }, []);

  useEffect(() => () => {
    pcRef.current?.close();
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list);
    const mic = cameraStreamRef.current?.getAudioTracks()[0]?.getSettings().deviceId;
    const camera = cameraStreamRef.current?.getVideoTracks()[0]?.getSettings().deviceId;
    if (mic) setSelectedMicId(mic);
    if (camera) setSelectedCameraId(camera);
  }, []);

  const acquireMedia = useCallback(async (mode: CallMode) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Браузер не поддерживает доступ к микрофону/камере.');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(selectedMicId ? { deviceId: { exact: selectedMicId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: mode === 'video' ? { ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } : false,
    });
    cameraStreamRef.current = stream;
    setLocalStream(new MediaStream(stream.getTracks()));
    setMicEnabled(stream.getAudioTracks().some((track) => track.enabled));
    setCameraEnabled(stream.getVideoTracks().some((track) => track.enabled));
    await refreshDevices().catch(() => {});
    return stream;
  }, [refreshDevices, selectedCameraId, selectedMicId]);

  const flushIce = useCallback(async (pc: RTCPeerConnection) => {
    const queued = pendingIceRef.current.splice(0);
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch {}
    }
  }, []);

  const ensurePeerConnection = useCallback(() => {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });
    pcRef.current = pc;
    recoveryTimerRef.current = setTimeout(() => { if (pc.connectionState !== 'connected' && pc.connectionState !== 'closed') { const active = callRef.current; if (active) { try { send({ type:'call:end', callId:active.id }); } catch {} } reset('Не удалось установить медиасоединение. Проверь сеть и настройки TURN.'); } }, 30000);
    const local = cameraStreamRef.current;
    if (local) for (const track of local.getTracks()) pc.addTrack(track, local);
    pc.onicecandidate = (event) => {
      const current = callRef.current;
      if (!current || !event.candidate) return;
      try { send({ type: 'call:ice', callId: current.id, candidate: event.candidate.toJSON() }); } catch {}
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      setRemoteStream(stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setCall(current => current ? { ...current, phase: 'active' } : current);
        if (recoveryTimerRef.current) { clearTimeout(recoveryTimerRef.current); recoveryTimerRef.current = null; }
        recoveryAttemptedRef.current = false;
        return;
      }
      if (pc.connectionState === 'disconnected') setCall(current => current ? { ...current, phase:'connecting' } : current);
      if (pc.connectionState === 'disconnected' && !recoveryTimerRef.current) {
        recoveryTimerRef.current = setTimeout(() => {
          recoveryTimerRef.current = null;
          const current = callRef.current;
          if (!current || pc.connectionState !== 'disconnected' || recoveryAttemptedRef.current) return;
          recoveryAttemptedRef.current = true;
          try { pc.restartIce(); } catch {}
          if (current.direction === 'outgoing') {
            void pc.createOffer({ iceRestart: true }).then(async (offer) => {
              await pc.setLocalDescription(offer);
              send({ type: 'call:offer', callId: current.id, sdp: offer });
            }).catch(() => {});
          }
        }, 2500);
        return;
      }
      if (pc.connectionState === 'failed') {
        const current = callRef.current;
        if (current && !current.id.startsWith('pending-')) {
          try { send({ type: 'call:end', callId: current.id }); } catch {}
        }
        reset('Соединение звонка потеряно.');
      }
    };
    return pc;
  }, [reset, send]);

  const startCall = useCallback(async (conversation: Conversation, mode: CallMode) => {
    if (callRef.current) { setNotice('Сначала заверши текущий звонок.'); return; }
    const target = conversation.members.find((member) => member.username === conversation.username);
    if (!target || conversation.kind !== 'direct' || conversation.isSaved || target.isBot) { setNotice('Звонок доступен только пользователю в личном чате.'); return; }
    const provisional: LiveCall = {
      id: `pending-${Date.now()}`,
      conversationId: conversation.id,
      mode,
      status: 'ringing',
      direction: 'outgoing',
      peer: target,
      startedAt: new Date().toISOString(),
      answeredAt: null,
      endedAt: null,
      endedBy: null,
      phase: 'ringing',
    };
    callRef.current = provisional;
    setCall(provisional);
    setNotice(null);
    try {
      await acquireMedia(mode);
      send({ type: 'call:start', conversationId: conversation.id, mode });
    } catch (error) {
      reset(error instanceof Error ? error.message : 'Не удалось начать звонок.');
    }
  }, [acquireMedia, reset, send]);

  const acceptCall = useCallback(async () => {
    const current = callRef.current;
    if (!current || current.phase !== 'incoming') return;
    try {
      await acquireMedia(current.mode);
      send({ type: 'call:accept', callId: current.id });
      const next = { ...current, phase: 'connecting' as const };
      callRef.current = next; setCall(next);
    } catch (error) {
      try { send({ type: 'call:reject', callId: current.id }); } catch {}
      reset(error instanceof Error ? error.message : 'Нет доступа к микрофону/камере.');
    }
  }, [acquireMedia, reset, send]);

  const declineCall = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    if (!current.id.startsWith('pending-')) {
      try { send({ type: current.phase === 'incoming' ? 'call:reject' : 'call:end', callId: current.id }); } catch {}
    }
    reset();
  }, [reset, send]);

  const endCall = useCallback(() => {
    const current = callRef.current;
    if (current && !current.id.startsWith('pending-')) {
      try { send({ type: 'call:end', callId: current.id }); } catch {}
    }
    reset();
  }, [reset, send]);

  const handleSocketEvent = useCallback(async (payload: CallSocketEvent) => {
    if (payload.type === 'call:incoming') {
      if (callRef.current) {
        try { send({ type: 'call:reject', callId: payload.call.id }); } catch {}
        return;
      }
      const incoming: LiveCall = { ...payload.call, phase: 'incoming' };
      callRef.current = incoming; setCall(incoming); setNotice(null);
      return;
    }
    if (payload.type === 'call:outgoing') {
      const outgoing: LiveCall = { ...payload.call, phase: 'ringing' };
      callRef.current = outgoing; setCall(outgoing);
      return;
    }
    if (payload.type === 'call:accepted') {
      const current = callRef.current;
      if (!current || current.id !== payload.call.id) return;
      const next: LiveCall = { ...payload.call, phase: 'connecting' };
      callRef.current = next; setCall(next);
      const pc = ensurePeerConnection();
      if (payload.call.direction === 'outgoing') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'call:offer', callId: payload.call.id, sdp: offer });
      }
      return;
    }
    if (payload.type === 'call:offer') {
      const current = callRef.current;
      if (!current || current.id !== payload.callId) return;
      const pc = ensurePeerConnection();
      await pc.setRemoteDescription(payload.sdp);
      await flushIce(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'call:answer', callId: payload.callId, sdp: answer });
      return;
    }
    if (payload.type === 'call:answer') {
      const current = callRef.current;
      if (!current || current.id !== payload.callId) return;
      const pc = ensurePeerConnection();
      await pc.setRemoteDescription(payload.sdp);
      await flushIce(pc);
      return;
    }
    if (payload.type === 'call:ice') {
      const current = callRef.current;
      if (!current || current.id !== payload.callId || !payload.candidate) return;
      const pc = ensurePeerConnection();
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(payload.candidate); } catch {}
      } else pendingIceRef.current.push(payload.candidate);
      return;
    }
    if (payload.type === 'call:dismiss') {
      if (callRef.current?.id === payload.callId) reset();
      return;
    }
    if (payload.type === 'call:failed') {
      reset(payload.message || 'Звонок не состоялся.');
      return;
    }
    if (payload.type === 'call:ended') {
      if (callRef.current?.id !== payload.call.id) return;
      const message = payload.reason === 'declined' ? 'Звонок отклонён.' : payload.reason === 'no_answer' ? 'Нет ответа.' : payload.reason === 'disconnected' ? 'Соединение прервано.' : undefined;
      reset(message);
    }
  }, [ensurePeerConnection, flushIce, reset, send]);

  const toggleMic = useCallback(() => {
    const tracks = cameraStreamRef.current?.getAudioTracks() || [];
    if (!tracks.length) return;
    const enabled = !tracks[0].enabled;
    tracks.forEach((track) => { track.enabled = enabled; });
    setMicEnabled(enabled);
  }, []);

  const toggleCamera = useCallback(() => {
    if (sharingScreen) return;
    const tracks = cameraStreamRef.current?.getVideoTracks() || [];
    if (!tracks.length) return;
    const enabled = !tracks[0].enabled;
    tracks.forEach((track) => { track.enabled = enabled; });
    setCameraEnabled(enabled);
  }, [sharingScreen]);

  const stopScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    const camera = cameraStreamRef.current;
    const cameraTrack = camera?.getVideoTracks()[0] || null;
    const sender = pc?.getSenders().find((item) => item.track?.kind === 'video');
    if (sender && cameraTrack) await sender.replaceTrack(cameraTrack).catch(() => {});
    screenStreamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    screenStreamRef.current = null;
    setSharingScreen(false);
    if (camera) setLocalStream(new MediaStream(camera.getTracks()));
  }, []);

  const toggleScreenShare = useCallback(async () => {
    const current = callRef.current;
    if (!current || current.mode !== 'video' || current.phase !== 'active') return;
    if (sharingScreen) { await stopScreenShare(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { setNotice('Демонстрация экрана не поддерживается этим браузером.'); return; }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = display.getVideoTracks()[0];
      const sender = pcRef.current?.getSenders().find((item) => item.track?.kind === 'video');
      if (!screenTrack || !sender) { display.getTracks().forEach((track) => track.stop()); throw new Error('Видеоканал ещё не готов.'); }
      await sender.replaceTrack(screenTrack);
      screenStreamRef.current = display;
      const audio = cameraStreamRef.current?.getAudioTracks() || [];
      setLocalStream(new MediaStream([screenTrack, ...audio]));
      setSharingScreen(true);
      screenTrack.onended = () => { void stopScreenShare(); };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') return;
      setNotice(error instanceof Error ? error.message : 'Не удалось начать демонстрацию экрана.');
    }
  }, [sharingScreen, stopScreenShare]);

  const switchMic = useCallback(async (deviceId: string) => {
    const current = cameraStreamRef.current;
    if (!current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const nextTrack = stream.getAudioTracks()[0];
      const previousTrack = current.getAudioTracks()[0];
      nextTrack.enabled = previousTrack?.enabled ?? true;
      const sender = pcRef.current?.getSenders().find((item) => item.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(nextTrack);
      previousTrack?.stop();
      const rebuilt = new MediaStream([nextTrack, ...current.getVideoTracks()]);
      cameraStreamRef.current = rebuilt;
      if (sharingScreen && screenStreamRef.current?.getVideoTracks()[0]) setLocalStream(new MediaStream([screenStreamRef.current.getVideoTracks()[0], nextTrack]));
      else setLocalStream(new MediaStream(rebuilt.getTracks()));
      setSelectedMicId(deviceId);
      setMicEnabled(nextTrack.enabled);
      await refreshDevices().catch(() => {});
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось переключить микрофон.'); }
  }, [refreshDevices, sharingScreen]);

  const switchCamera = useCallback(async (deviceId: string) => {
    const current = cameraStreamRef.current;
    const active = callRef.current;
    if (!current || active?.mode !== 'video') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } });
      const nextTrack = stream.getVideoTracks()[0];
      const previousTrack = current.getVideoTracks()[0];
      nextTrack.enabled = previousTrack?.enabled ?? true;
      if (!sharingScreen) {
        const sender = pcRef.current?.getSenders().find((item) => item.track?.kind === 'video');
        if (sender) await sender.replaceTrack(nextTrack);
      }
      previousTrack?.stop();
      const rebuilt = new MediaStream([...current.getAudioTracks(), nextTrack]);
      cameraStreamRef.current = rebuilt;
      if (!sharingScreen) setLocalStream(new MediaStream(rebuilt.getTracks()));
      setSelectedCameraId(deviceId);
      setCameraEnabled(nextTrack.enabled);
      await refreshDevices().catch(() => {});
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось переключить камеру.'); }
  }, [refreshDevices, sharingScreen]);

  useEffect(() => {
    if (!call || call.phase !== 'active') return;
    const timer = window.setInterval(() => {
      const pc = pcRef.current;
      if (!pc) return;
      void pc.getStats().then((stats) => {
        let rttMs: number | null = null;
        let jitterMs: number | null = null;
        let lost = 0;
        let received = 0;
        let bytes = 0;
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) rttMs = Math.round(Number(report.currentRoundTripTime) * 1000);
          if (report.type === 'inbound-rtp' && !report.isRemote) {
            if (report.jitter != null) jitterMs = Math.round(Number(report.jitter) * 1000);
            lost += Math.max(0, Number(report.packetsLost || 0));
            received += Math.max(0, Number(report.packetsReceived || 0));
            bytes += Math.max(0, Number(report.bytesReceived || 0));
          }
        });
        const now = Date.now();
        const prev = statsRef.current;
        const bitrateKbps = prev && now > prev.at ? Math.max(0, Math.round(((bytes - prev.bytes) * 8) / (now - prev.at))) : null;
        statsRef.current = { bytes, at: now };
        const total = lost + received;
        setQuality({ rttMs, jitterMs, packetLoss: total ? Math.round((lost / total) * 1000) / 10 : 0, bitrateKbps });
      }).catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [call]);

  return { call, localStream, remoteStream, micEnabled, cameraEnabled, sharingScreen, devices, selectedMicId, selectedCameraId, notice, quality, startCall, acceptCall, declineCall, endCall, toggleMic, toggleCamera, toggleScreenShare, switchMic, switchCamera, handleSocketEvent };
}


export function useVoiceRoomController(socketRef: { current: WebSocket | null }) {
  const [selfUserId, setSelfUserId] = useState('');
  const [room, setRoom] = useState<VoiceRoomWire | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState('');
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const roomRef = useRef<VoiceRoomWire | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  useEffect(() => { roomRef.current = room; }, [room]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const send = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Realtime-соединение недоступно.');
    socket.send(JSON.stringify(payload));
  }, [socketRef]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list);
    const mic = cameraStreamRef.current?.getAudioTracks()[0]?.getSettings().deviceId;
    const cam = cameraStreamRef.current?.getVideoTracks()[0]?.getSettings().deviceId;
    if (mic) setSelectedMicId(mic);
    if (cam) setSelectedCameraId(cam);
  }, []);

  const acquireMedia = useCallback(async (mode: 'audio' | 'video', micId?: string, cameraId?: string) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Браузер не поддерживает доступ к медиаустройствам.');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(micId ? { deviceId: { exact: micId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: mode === 'video' ? { ...(cameraId ? { deviceId: { exact: cameraId } } : {}), width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } } : false,
    });
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = stream;
    localStreamRef.current = new MediaStream(stream.getTracks());
    setLocalStream(new MediaStream(stream.getTracks()));
    setMicEnabled(stream.getAudioTracks().some((track) => track.enabled));
    setCameraEnabled(stream.getVideoTracks().some((track) => track.enabled));
    await refreshDevices().catch(() => {});
    return stream;
  }, [refreshDevices]);

  const closePeer = useCallback((userId: string) => {
    peersRef.current.get(userId)?.close(); peersRef.current.delete(userId); pendingIceRef.current.delete(userId);
    setRemoteStreams((current) => { const next = { ...current }; delete next[userId]; return next; });
  }, []);

  const reset = useCallback((message?: string) => {
    for (const pc of peersRef.current.values()) pc.close();
    peersRef.current.clear(); pendingIceRef.current.clear();
    screenStreamRef.current?.getTracks().forEach((track) => track.stop()); screenStreamRef.current = null;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop()); cameraStreamRef.current = null;
    localStreamRef.current = null; roomRef.current = null;
    setLocalStream(null); setRemoteStreams({}); setRoom(null); setMicEnabled(true); setCameraEnabled(false); setSharingScreen(false);
    if (message) setNotice(message);
  }, []);
  useEffect(() => () => reset(), [reset]);

  const ensurePeer = useCallback((userId: string) => {
    const existing = peersRef.current.get(userId); if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: getIceServers() }); peersRef.current.set(userId, pc);
    const local = localStreamRef.current; if (local) for (const track of local.getTracks()) pc.addTrack(track, local);
    pc.onicecandidate = (event) => { const active = roomRef.current; if (active && event.candidate) { try { send({ type: 'room:ice', roomId: active.id, targetUserId: userId, candidate: event.candidate.toJSON() }); } catch {} } };
    pc.ontrack = (event) => { const stream = event.streams[0] || new MediaStream([event.track]); setRemoteStreams((current) => ({ ...current, [userId]: stream })); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(userId); };
    return pc;
  }, [closePeer, send]);

  const flushIce = useCallback(async (userId: string, pc: RTCPeerConnection) => {
    const pending = pendingIceRef.current.get(userId) || []; pendingIceRef.current.delete(userId);
    for (const candidate of pending) { try { await pc.addIceCandidate(candidate); } catch {} }
  }, []);
  const createOfferTo = useCallback(async (targetUserId: string) => {
    const active = roomRef.current; if (!active) return;
    const pc = ensurePeer(targetUserId); const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    send({ type: 'room:offer', roomId: active.id, targetUserId, sdp: offer });
  }, [ensurePeer, send]);

  const joinRoom = useCallback(async (conversation: Conversation, mode: 'audio' | 'video' = 'audio') => {
    if (conversation.kind !== 'group') { setNotice('Групповые комнаты доступны только в группах.'); return; }
    const current = roomRef.current;
    if (current?.conversationId === conversation.id && current.mode === mode) return;
    if (current) { setNotice('Сначала выйди из текущей комнаты.'); return; }
    try {
      await acquireMedia(mode, selectedMicId || undefined, selectedCameraId || undefined);
      send({ type: 'room:join', conversationId: conversation.id, mode });
    } catch (error) { reset(error instanceof Error ? error.message : 'Не удалось войти в комнату.'); }
  }, [acquireMedia, reset, selectedCameraId, selectedMicId, send]);

  const leaveRoom = useCallback(() => { if (roomRef.current) { try { send({ type: 'room:leave', roomId: roomRef.current.id }); } catch {} } reset(); }, [reset, send]);
  const toggleMic = useCallback(() => { const tracks = cameraStreamRef.current?.getAudioTracks() || []; if (!tracks.length) return; const enabled = !tracks[0].enabled; tracks.forEach((t) => { t.enabled = enabled; }); setMicEnabled(enabled); }, []);
  const toggleCamera = useCallback(() => { const tracks = cameraStreamRef.current?.getVideoTracks() || []; if (!tracks.length) return; const enabled = !tracks[0].enabled; tracks.forEach((t) => { t.enabled = enabled; }); setCameraEnabled(enabled); }, []);

  const switchMic = useCallback(async (deviceId: string) => {
    try {
      const oldStream = cameraStreamRef.current; const oldTrack = oldStream?.getAudioTracks()[0]; const enabled = oldTrack?.enabled ?? true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const track = stream.getAudioTracks()[0]; track.enabled = enabled;
      for (const pc of peersRef.current.values()) { const sender = pc.getSenders().find((x) => x.track?.kind === 'audio'); if (sender) await sender.replaceTrack(track); }
      oldTrack?.stop();
      const videoTrack = oldStream?.getVideoTracks()[0]; const nextCamera = new MediaStream([track, ...(videoTrack ? [videoTrack] : [])]); cameraStreamRef.current = nextCamera;
      const displayVideo = sharingScreen ? screenStreamRef.current?.getVideoTracks()[0] : videoTrack;
      const display = new MediaStream([track, ...(displayVideo ? [displayVideo] : [])]); localStreamRef.current = display; setLocalStream(display);
      setSelectedMicId(deviceId); setMicEnabled(enabled); await refreshDevices().catch(() => {});
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось переключить микрофон.'); }
  }, [refreshDevices, sharingScreen]);

  const switchCamera = useCallback(async (deviceId: string) => {
    if (roomRef.current?.mode !== 'video') return;
    try {
      const oldStream = cameraStreamRef.current; const oldTrack = oldStream?.getVideoTracks()[0]; const enabled = oldTrack?.enabled ?? true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: deviceId }, width: { ideal: 960 }, height: { ideal: 540 } } });
      const track = stream.getVideoTracks()[0]; track.enabled = enabled;
      if (!sharingScreen) for (const pc of peersRef.current.values()) { const sender = pc.getSenders().find((x) => x.track?.kind === 'video'); if (sender) await sender.replaceTrack(track); }
      oldTrack?.stop();
      const audio = oldStream?.getAudioTracks()[0]; const nextCamera = new MediaStream([...(audio ? [audio] : []), track]); cameraStreamRef.current = nextCamera;
      if (!sharingScreen) { localStreamRef.current = new MediaStream(nextCamera.getTracks()); setLocalStream(new MediaStream(nextCamera.getTracks())); }
      setSelectedCameraId(deviceId); setCameraEnabled(enabled); await refreshDevices().catch(() => {});
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось переключить камеру.'); }
  }, [refreshDevices, sharingScreen]);

  const toggleScreenShare = useCallback(async () => {
    if (roomRef.current?.mode !== 'video') return;
    if (sharingScreen) {
      const camera = cameraStreamRef.current?.getVideoTracks()[0] || null;
      if (camera) for (const pc of peersRef.current.values()) { const sender = pc.getSenders().find((x) => x.track?.kind === 'video'); if (sender) await sender.replaceTrack(camera); }
      screenStreamRef.current?.getTracks().forEach((t) => t.stop()); screenStreamRef.current = null; setSharingScreen(false);
      if (cameraStreamRef.current) { const next = new MediaStream(cameraStreamRef.current.getTracks()); localStreamRef.current = next; setLocalStream(next); }
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); const screen = display.getVideoTracks()[0]; screenStreamRef.current = display;
      for (const pc of peersRef.current.values()) { const sender = pc.getSenders().find((x) => x.track?.kind === 'video'); if (sender) await sender.replaceTrack(screen); }
      const audio = cameraStreamRef.current?.getAudioTracks()[0]; const next = new MediaStream([...(audio ? [audio] : []), screen]); localStreamRef.current = next; setLocalStream(next); setSharingScreen(true);
      screen.onended = () => { const camera = cameraStreamRef.current?.getVideoTracks()[0]; for (const pc of peersRef.current.values()) { const sender = pc.getSenders().find(x => x.track?.kind === 'video'); if (camera && sender) void sender.replaceTrack(camera).catch(() => {}); } screenStreamRef.current?.getTracks().forEach(t => t.stop()); screenStreamRef.current = null; setSharingScreen(false); if (cameraStreamRef.current) { const next = new MediaStream(cameraStreamRef.current.getTracks()); localStreamRef.current = next; setLocalStream(next); } };
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось начать демонстрацию экрана.'); }
  }, [sharingScreen]);

  const handleSocketEvent = useCallback(async (payload: RoomSocketEvent) => {
    if (payload.type === 'room:failed') { reset(payload.message); return; }
    if (payload.type === 'room:joined') { setSelfUserId(payload.selfUserId); roomRef.current = payload.room; setRoom(payload.room); await refreshDevices().catch(() => {}); return; }
    const active = roomRef.current; if (!active || active.id !== payload.roomId) return;
    if (payload.type === 'room:participant-joined') { setRoom((current) => current ? { ...current, participants: [...current.participants.filter((x) => x.id !== payload.participant.id), payload.participant] } : current); await createOfferTo(payload.participant.id).catch(() => closePeer(payload.participant.id)); return; }
    if (payload.type === 'room:participant-left') { closePeer(payload.userId); setRoom((current) => current ? { ...current, participants: current.participants.filter((x) => x.id !== payload.userId) } : current); return; }
    if (payload.type === 'room:offer') { const pc = ensurePeer(payload.fromUserId); await pc.setRemoteDescription(payload.sdp); await flushIce(payload.fromUserId, pc); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); send({ type: 'room:answer', roomId: active.id, targetUserId: payload.fromUserId, sdp: answer }); return; }
    if (payload.type === 'room:answer') { const pc = ensurePeer(payload.fromUserId); await pc.setRemoteDescription(payload.sdp); await flushIce(payload.fromUserId, pc); return; }
    if (payload.type === 'room:ice' && payload.candidate) { const pc = ensurePeer(payload.fromUserId); if (pc.remoteDescription) { try { await pc.addIceCandidate(payload.candidate); } catch {} } else { const list = pendingIceRef.current.get(payload.fromUserId) || []; list.push(payload.candidate); pendingIceRef.current.set(payload.fromUserId, list); } }
  }, [closePeer, createOfferTo, ensurePeer, flushIce, refreshDevices, reset, send]);

  return { selfUserId, room, localStream, remoteStreams, micEnabled, cameraEnabled, sharingScreen, devices, selectedMicId, selectedCameraId, notice, joinRoom, leaveRoom, toggleMic, toggleCamera, toggleScreenShare, switchMic, switchCamera, handleSocketEvent };
}

type VoiceRoomController = ReturnType<typeof useVoiceRoomController>;

export function VoiceRoomOverlay({ token, controller }: { token: string; controller: VoiceRoomController }) {
  const { selfUserId, room, localStream, remoteStreams, micEnabled, cameraEnabled, sharingScreen, devices, selectedMicId, selectedCameraId, notice } = controller;
  const speaking = useActiveSpeaker(remoteStreams, localStream, selfUserId);
  if (!room) return notice ? <div className="callToast voiceRoomToast">{notice}</div> : null;
  const microphones = devices.filter((item) => item.kind === 'audioinput');
  const cameras = devices.filter((item) => item.kind === 'videoinput');
  const video = room.mode === 'video';
  const limit = video ? 6 : 8;
  return <div className={`voiceRoomOverlay ${video ? 'videoRoomOverlay' : ''}`}>
    <section className="voiceRoomPanel">
      <header><div><span className="eyebrow">{video ? 'ГРУППОВОЙ ЗВОНОК' : 'ГОЛОСОВАЯ КОМНАТА'} · {room.participants.length}/{limit}</span><h2>{room.title}</h2><p>{video ? 'Видеокомната' : 'Голосовая комната'} · Встреча в твоём кругу</p></div><button aria-label="Выйти из комнаты" onClick={controller.leaveRoom}><Icon name="close" /></button></header>
      {video ? <div className="groupVideoGrid">
        {localStream && <div className={`groupVideoTile self ${speaking === selfUserId ? 'speaking' : ''}`}><CallMedia stream={localStream} video muted /><span>Вы{!micEnabled ? ' · микрофон выключен' : sharingScreen ? ' · экран' : ''}</span></div>}
        {room.participants.filter(participant => participant.id !== selfUserId).map((participant) => <div className={`groupVideoTile ${speaking === participant.id ? 'speaking' : ''}`} key={participant.id}>{remoteStreams[participant.id] ? <CallMedia stream={remoteStreams[participant.id]} video /> : <div className="videoPlaceholder"><Avatar token={token} name={participant.displayName} mediaId={participant.avatarMediaId} className="voiceParticipantAvatar" /></div>}<span>{participant.displayName}</span></div>)}
      </div> : <div className="voiceParticipants">
        {room.participants.map((participant) => <div className={`voiceParticipant ${speaking === participant.id ? 'speaking' : ''}`} key={participant.id}>
          <Avatar token={token} name={participant.displayName} mediaId={participant.avatarMediaId} className="voiceParticipantAvatar" />
          <div><b>{participant.displayName}</b><span>@{participant.username}</span></div><i>{participant.id === selfUserId ? (micEnabled ? 'Вы' : 'Без звука') : remoteStreams[participant.id]?.getAudioTracks().some(track => !track.muted && track.readyState === 'live') ? 'В эфире' : 'Подключение'}</i>
        </div>)}
        {(Object.entries(remoteStreams) as [string, MediaStream][]).map(([userId, stream]) => <CallMedia key={userId} stream={stream} />)}
      </div>}
      <div className="voiceRoomDeviceRow">
        <label>Микрофон<select value={selectedMicId} onChange={(event) => void controller.switchMic(event.target.value)}>{microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Микрофон ${index + 1}`}</option>)}</select></label>
        {video && <label>Камера<select value={selectedCameraId} disabled={sharingScreen} onChange={(event) => void controller.switchCamera(event.target.value)}>{cameras.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Камера ${index + 1}`}</option>)}</select></label>}
      </div>
      <footer><button className={!micEnabled ? 'off' : ''} onClick={controller.toggleMic}>{micEnabled ? 'Микрофон' : 'Без звука'}</button>{video && <button className={!cameraEnabled ? 'off' : ''} onClick={controller.toggleCamera}>{cameraEnabled ? 'Камера' : 'Камера выкл.'}</button>}{video && <button className={sharingScreen ? 'active' : ''} onClick={() => void controller.toggleScreenShare()}>{sharingScreen ? 'Вернуть камеру' : 'Экран'}</button>}<button className="leaveVoiceRoom" onClick={controller.leaveRoom}>Выйти</button></footer>
    </section>
  </div>;
}

type CallController = ReturnType<typeof useCallController>;

export function CallOverlay({ token, controller }: { token: string; controller: CallController }) {
  const { call, localStream, remoteStream, micEnabled, cameraEnabled, sharingScreen, devices, selectedMicId, selectedCameraId, notice, quality } = controller;
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!call || call.phase !== 'active') return;
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [call]);
  if (!call) return notice ? <div className="callToast">{notice}</div> : null;
  const peer = call.peer;
  const video = call.mode === 'video';
  const status = call.phase === 'incoming' ? `Входящий ${video ? 'видеозвонок' : 'звонок'}` : call.phase === 'ringing' ? 'Вызов…' : call.phase === 'connecting' ? 'Соединение…' : call.answeredAt ? formatCallDuration(new Date(call.answeredAt).getTime(), tick) : 'Соединено';
  return <div className={`callOverlay ${video ? 'videoCall' : 'audioCall'}`}>
    {video && remoteStream ? <CallMedia stream={remoteStream} video className="remoteVideo" /> : <div className="callBackdrop"><Avatar token={token} name={peer?.displayName || 'Unknown'} mediaId={peer?.avatarMediaId} className="callAvatar" /><strong>{peer?.displayName || 'Unknown'}</strong><span>@{peer?.username || 'unknown'}</span></div>}
    {video && localStream && <CallMedia stream={localStream} video muted className="localVideo" />}
    {!video && remoteStream && <CallMedia stream={remoteStream} />}
    <div className="callTop"><div><b>{peer?.displayName || 'Unknown'}</b><span>{status}</span>{call.phase === 'active' && <small className="callQuality">RTT {quality.rttMs ?? '—'} ms · jitter {quality.jitterMs ?? '—'} ms · loss {quality.packetLoss ?? '—'}% · {quality.bitrateKbps ?? '—'} kbps</small>}</div><i>{video ? 'VIDEO' : 'VOICE'}</i></div>
    {call.phase !== 'incoming' && localStream && <div className="callDevicePicker"><label>Микрофон<select value={selectedMicId} onChange={(event) => void controller.switchMic(event.target.value)}>{devices.filter((device) => device.kind === 'audioinput').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Микрофон ${index + 1}`}</option>)}</select></label>{video && <label>Камера<select value={selectedCameraId} disabled={sharingScreen} onChange={(event) => void controller.switchCamera(event.target.value)}>{devices.filter((device) => device.kind === 'videoinput').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Камера ${index + 1}`}</option>)}</select></label>}</div>}
    {call.phase === 'incoming' ? <div className="incomingCallActions"><button className="callDecline" aria-label="Отклонить звонок" onClick={controller.declineCall}>✕</button><button className="callAccept" aria-label="Принять звонок" onClick={() => void controller.acceptCall()}><Icon name="phone" /></button></div> : <div className="callControls">
      <button className={!micEnabled ? 'off' : ''} title={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'} onClick={controller.toggleMic}><Icon name="mic" /></button>
      {video && <button className={!cameraEnabled ? 'off' : ''} title="Камера" onClick={controller.toggleCamera}><Icon name="video" /></button>}
      {video && call.phase === 'active' && <button className={sharingScreen ? 'active' : ''} title="Демонстрация экрана" onClick={() => void controller.toggleScreenShare()}>{sharingScreen ? 'Вернуть камеру' : 'Экран'}</button>}
      <button className="hangup" title="Завершить" onClick={controller.endCall}>✕</button>
    </div>}
  </div>;
}

function CallMedia({ stream, video = false, muted = false, className = '' }: { stream: MediaStream; video?: boolean; muted?: boolean; className?: string }) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  useEffect(() => { if (mediaRef.current) mediaRef.current.srcObject = stream; }, [stream]);
  if (video) return <video ref={(node) => { mediaRef.current = node; }} className={className} autoPlay playsInline muted={muted} />;
  return <audio ref={(node) => { mediaRef.current = node; }} autoPlay muted={muted} />;
}

export function CallHistoryModal({ token, api, onClose }: { token: string; api: <T>(path: string, init?: RequestInit) => Promise<T>; onClose: () => void }) {
  const [error, setError] = useState('');
  const [calls, setCalls] = useState<CallWire[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void api<{ calls: CallWire[] }>('/calls/history?limit=80').then((data) => { if (!cancelled) setCalls(data.calls); }).catch(() => { if (!cancelled) setError('История недоступна. Проверь соединение и открой окно снова.'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api]);
  return <Modal onClose={onClose}>
    <section className="settingsModal callsModal"><header><div><span className="eyebrow">CALLS</span><h2>История звонков</h2></div><button onClick={onClose}>×</button></header>
      {error && <div className="errorBox" role="alert">{error}</div>}{loading ? <p className="muted">Загрузка…</p> : calls.length ? <div className="callHistoryList">{calls.map((item) => <div className="callHistoryCard" key={item.id}><Avatar token={token} name={item.peer?.displayName || 'Unknown'} mediaId={item.peer?.avatarMediaId} className="memberAvatar" /><div><strong>{item.peer?.displayName || 'Unknown'}</strong><span>{item.direction === 'outgoing' ? '↗ Исходящий' : '↙ Входящий'} · {item.mode === 'video' ? 'видео' : 'аудио'} · {callStatusLabel(item.status)}</span><small>{new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(item.startedAt))}{item.answeredAt && item.endedAt ? ` · ${formatCallDuration(new Date(item.answeredAt).getTime(), new Date(item.endedAt).getTime())}` : ''}</small></div></div>)}</div> : <p className="muted">Звонков пока нет.</p>}
    </section>
  </Modal>;
}

function callStatusLabel(status: string) { if (status === 'missed') return 'пропущен'; if (status === 'declined') return 'отклонён'; if (status === 'cancelled') return 'отменён'; if (status === 'ended') return 'завершён'; if (status === 'active') return 'активен'; return status; }
function formatCallDuration(start: number, end: number) { const total = Math.max(0, Math.floor((end - start) / 1000)); const minutes = Math.floor(total / 60); const seconds = total % 60; return `${minutes}:${String(seconds).padStart(2, '0')}`; }

function useActiveSpeaker(remote: Record<string, MediaStream>, local: MediaStream | null, selfId: string) {
  const [speaker,setSpeaker] = useState<string | null>(null);
  useEffect(() => {
    if (!local && !Object.keys(remote).length) return;
    const audio = new AudioContext();
    const streams = {...remote, ...(local && selfId ? {[selfId]:local} : {})};
    const nodes: { id:string; analyser:AnalyserNode; source:MediaStreamAudioSourceNode; values:Uint8Array<ArrayBuffer> }[] = [];
    for (const [id,stream] of Object.entries(streams)) if (stream.getAudioTracks().length) {
      try { const analyser = audio.createAnalyser(); analyser.fftSize=256; const source=audio.createMediaStreamSource(stream); source.connect(analyser); nodes.push({id,analyser,source,values:new Uint8Array(analyser.fftSize)}); } catch {}
    }
    void audio.resume().catch(()=>{});
    const timer=setInterval(()=>{ let loudest:string|null=null;let volume=0.025;
      for(const node of nodes) { node.analyser.getByteTimeDomainData(node.values); let sum=0;for(const value of node.values) sum+=((value-128)/128)**2;const rms=Math.sqrt(sum/node.values.length);if(rms>volume){volume=rms;loudest=node.id;} }
      setSpeaker(current=>current===loudest?current:loudest);
    },250);
    return ()=>{clearInterval(timer);nodes.forEach(node=>{node.source.disconnect();node.analyser.disconnect();});void audio.close().catch(()=>{});};
  },[remote,local,selfId]);
  return speaker;
}
