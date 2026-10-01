// Exact v0.14 initializer retained only as a migration regression fixture.
import Database from 'better-sqlite3';
const db = new Database(process.argv[2]);
db.pragma('foreign_keys = ON');
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('direct', 'group')),
      direct_key TEXT UNIQUE,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL,
      last_read_at TEXT,
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT
    );

    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id);
  `);

  ensureColumn('sessions', 'last_seen_at', 'TEXT');
  ensureColumn('sessions', 'user_agent', 'TEXT');
  ensureColumn('sessions', 'ip_address', 'TEXT');
  ensureColumn('messages', 'deleted_at', 'TEXT');
  ensureColumn('messages', 'reply_to_message_id', 'TEXT');
  ensureColumn('messages', 'attachment_id', 'TEXT');
  ensureColumn('users', 'bio', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'avatar_media_id', 'TEXT');
  ensureColumn('users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'two_factor_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'totp_secret_enc', 'TEXT');
  ensureColumn('users', 'privacy_last_seen', "TEXT NOT NULL DEFAULT 'everyone'");
  ensureColumn('users', 'privacy_calls', "TEXT NOT NULL DEFAULT 'everyone'");
  ensureColumn('users', 'privacy_groups', "TEXT NOT NULL DEFAULT 'everyone'");
  ensureColumn('users', 'read_receipts', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('conversations', 'avatar_media_id', 'TEXT');
  ensureColumn('conversations', 'pinned_message_id', 'TEXT');
  ensureColumn('conversations', 'is_channel', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('conversations', 'public_username', 'TEXT');
  ensureColumn('conversations', 'description', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('conversations', 'discussion_conversation_id', 'TEXT');
  ensureColumn('conversations', 'is_discussion', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('conversation_members', 'muted_until', 'TEXT');
  ensureColumn('conversation_members', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('conversation_members', 'pinned_at', 'TEXT');
  ensureColumn('messages', 'channel_post_id', 'TEXT');
  ensureColumn('messages', 'forwarded_from_message_id', 'TEXT');
  ensureColumn('messages', 'client_request_id', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);

    CREATE TABLE IF NOT EXISTS message_mentions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_user ON message_mentions(user_id, message_id);

    CREATE TABLE IF NOT EXISTS group_invites (
      token TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      uses INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invites_conversation ON group_invites(conversation_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON user_blocks(blocked_id);

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_public_username
      ON conversations(public_username) WHERE public_username IS NOT NULL;

    CREATE TABLE IF NOT EXISTS channel_post_views (
      post_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_views_post ON channel_post_views(post_id);
    CREATE INDEX IF NOT EXISTS idx_channel_comments_post ON messages(channel_post_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_client_request ON messages(sender_id, client_request_id) WHERE client_request_id IS NOT NULL;


    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_user_created ON activity_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_user_unread ON activity_events(user_id, read_at);

    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      callee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      mode TEXT NOT NULL DEFAULT 'audio',
      status TEXT NOT NULL DEFAULT 'ringing',
      started_at TEXT NOT NULL,
      answered_at TEXT,
      ended_at TEXT,
      ended_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_calls_caller_started ON calls(caller_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_callee_started ON calls(callee_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS voice_rooms (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      started_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_voice_rooms_conversation ON voice_rooms(conversation_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS voice_room_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES voice_rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      left_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_voice_room_participants_room ON voice_room_participants(room_id, joined_at);
    CREATE INDEX IF NOT EXISTS idx_voice_room_participants_user ON voice_room_participants(user_id, joined_at DESC);

    CREATE TABLE IF NOT EXISTS push_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL DEFAULT 'android',
      device_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      attachment_id TEXT REFERENCES media(id) ON DELETE SET NULL,
      send_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(status, send_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_messages(user_id, status, send_at);

    CREATE TABLE IF NOT EXISTS sync_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_user_seq ON sync_events(user_id, seq);

    CREATE TABLE IF NOT EXISTS user_drafts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS chat_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_folders_user ON chat_folders(user_id, position);

    CREATE TABLE IF NOT EXISTS chat_folder_items (
      folder_id TEXT NOT NULL REFERENCES chat_folders(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      PRIMARY KEY (folder_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      chunk_size INTEGER NOT NULL,
      total_chunks INTEGER NOT NULL,
      media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'uploading',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions(user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS upload_chunks (
      upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (upload_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Passkey',
      credential_id TEXT NOT NULL UNIQUE,
      public_key_b64 TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports_json TEXT NOT NULL DEFAULT '[]',
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_logs(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      webhook_url TEXT,
      mini_app_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id, created_at DESC);
  `);
  ensureColumn('bots', 'mini_app_url', 'TEXT');
  ensureColumn('voice_rooms', 'mode', "TEXT NOT NULL DEFAULT 'audio'");
  db.prepare(`UPDATE calls SET status = 'ended', ended_at = COALESCE(ended_at, ?), ended_by = COALESCE(ended_by, 'system') WHERE status IN ('ringing','active')`).run(new Date().toISOString());
  db.prepare(`UPDATE voice_rooms SET ended_at = COALESCE(ended_at, ?) WHERE ended_at IS NULL`).run(new Date().toISOString());
  db.prepare(`UPDATE voice_room_participants SET left_at = COALESCE(left_at, ?) WHERE left_at IS NULL`).run(new Date().toISOString());
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}


initDatabase(); db.close();
