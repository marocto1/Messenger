export type User = { id: string; username: string; displayName: string; bio: string; avatarMediaId: string | null; createdAt: string; isBot?: boolean; role?: 'owner' | 'admin' | 'member' };
export type Attachment = { id: string; fileName: string; mimeType: string; size: number };
export type ReplyPreview = { id: string; senderDisplayName: string; body: string };
export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  senderUsername: string;
  senderDisplayName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  readByOther: boolean;
  mentionsMe: boolean;
  replyTo: ReplyPreview | null;
  attachment: Attachment | null;
  albumId?: string | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  channelPostId: string | null;
  viewsCount: number;
  commentsCount: number;
  forwardedFrom: ReplyPreview | null;
};
export type Conversation = {
  id: string;
  kind: 'direct' | 'group' | 'channel';
  isSaved?: boolean;
  title: string;
  username: string | null;
  avatarMediaId: string | null;
  members: User[];
  myRole: 'owner' | 'admin' | 'member';
  description: string;
  publicUsername: string | null;
  subscriberCount: number;
  discussionConversationId: string | null;
  pinnedMessageId: string | null;
  pinnedMessage: ReplyPreview | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageSenderName?: string | null;
  lastMessageSenderId?: string | null;
  lastReadAt?: string | null;
  unreadCount: number;
  mentionCount: number;
  muted: boolean;
  muteUntil: string | null;
  archived: boolean;
  pinned: boolean;
  pinnedAt: string | null;
  blockedByMe: boolean;
  blockedByOther: boolean;
  updatedAt: string;
};
export type Session = {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string;
  ipAddress: string | null;
  current: boolean;
};
export type Activity = {
  id: string;
  type: 'mention' | 'reply' | 'reaction' | 'channel_comment' | string;
  actor: { id: string; username: string; displayName: string } | null;
  conversationId: string | null;
  conversationTitle: string | null;
  conversationKind: string | null;
  messageId: string | null;
  messagePreview: string;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
};
export type Bot = {
  id: string; userId: string; username: string; displayName: string; avatarMediaId: string | null;
  tokenPrefix: string; webhookUrl: string | null; miniAppUrl: string | null; createdAt: string; updatedAt: string;
};
export type OutboxItem = {
  id: string;
  conversationId: string;
  body: string;
  replyToId: string | null;
  createdAt: string;
  attempts: number;
  lastError?: string;
  failed?: boolean;
  attachmentId?: string;
  albumId?: string;
};
export type MediaGalleryItem = Attachment & {
  messageId: string;
  createdAt: string;
  senderId: string;
  senderDisplayName: string;
};
export type ChatFolder = { id: string; name: string; position: number; conversationIds: string[] };
export type PrivacySettings = { lastSeen: 'everyone' | 'contacts' | 'nobody'; calls: 'everyone' | 'contacts' | 'nobody'; groups: 'everyone' | 'contacts' | 'nobody'; readReceipts: boolean };
export type CallQuality = { rttMs: number | null; jitterMs: number | null; packetLoss: number | null; bitrateKbps: number | null };

export type CallMode = 'audio' | 'video';
export type CallWire = {
  id: string;
  conversationId: string | null;
  mode: CallMode;
  status: string;
  direction: 'incoming' | 'outgoing';
  peer: User | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endedBy: string | null;
};
export type LiveCall = CallWire & { phase: 'incoming' | 'ringing' | 'connecting' | 'active' };
export type CallSocketEvent =
  | { type: 'call:incoming' | 'call:outgoing' | 'call:accepted' | 'call:ended'; call: CallWire; reason?: string }
  | { type: 'call:dismiss'; callId: string }
  | { type: 'call:failed'; reason: string; message: string; call?: CallWire }
  | { type: 'call:offer' | 'call:answer'; callId: string; sdp: RTCSessionDescriptionInit }
  | { type: 'call:ice'; callId: string; candidate: RTCIceCandidateInit | null };

export type VoiceRoomParticipant = User & { joinedAt: string };
export type VoiceRoomWire = { id: string; conversationId: string; title: string; mode: 'audio' | 'video'; startedAt: string; participants: VoiceRoomParticipant[] };
export type RoomSocketEvent =
  | { type: 'room:joined'; room: VoiceRoomWire; selfUserId: string }
  | { type: 'room:participant-joined'; roomId: string; participant: VoiceRoomParticipant }
  | { type: 'room:participant-left'; roomId: string; userId: string; reason?: string }
  | { type: 'room:failed'; message: string }
  | { type: 'room:offer' | 'room:answer'; roomId: string; fromUserId: string; sdp: RTCSessionDescriptionInit }
  | { type: 'room:ice'; roomId: string; fromUserId: string; candidate: RTCIceCandidateInit | null };
export type SocketEvent =
  | { type: 'ready'; userId: string }
  | { type: 'message:new'; message: Message }
  | { type: 'message:updated'; message: Message }
  | { type: 'message:deleted'; message: Message }
  | { type: 'typing'; conversationId: string; userId: string; active: boolean }
  | { type: 'presence'; userId: string; online: boolean }
  | { type: 'conversation:read'; conversationId: string; userId: string; at: string }
  | { type: 'message:reaction'; conversationId: string; messageId: string }
  | { type: 'conversation:updated'; conversationId?: string }
  | { type: 'conversation:added'; conversation: Conversation }
  | { type: 'conversation:removed'; conversationId: string }
  | { type: 'privacy:updated'; userId: string }
  | { type: 'channel:comments'; conversationId: string; postId: string }
  | { type: 'activity:new'; activity: Activity }
  | { type: 'activity:read' }
  | { type: 'scheduled:sent'; scheduledId: string; message: Message }
  | { type: 'scheduled:failed'; scheduledId: string; message: string }
  | { type: 'draft:updated'; conversationId: string; body: string; replyToId: string | null; updatedAt: string }
  | CallSocketEvent
  | RoomSocketEvent;
