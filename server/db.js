import Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';

const RPC_BUFFER_BYTES = 32 * 1024 * 1024;
const RPC_TIMEOUT_MS = Number(process.env.DB_SYNC_TIMEOUT_MS || 30_000);
const decoder = new TextDecoder();

export function createDatabase(sqlitePath) {
  if (!process.env.DATABASE_URL) return new Database(sqlitePath);
  return new PostgresSyncDatabase(process.env.DATABASE_URL);
}

class PostgresSyncDatabase {
  constructor(connectionString) {
    this.worker = new Worker(new URL('./db-postgres-worker.js', import.meta.url), {
      workerData: { connectionString }
    });
    this.closed = false;
    this.transactionDepth = 0;
    this.worker.on('error', (error) => {
      console.error('[db] Postgres worker error:', error);
    });
    this.#rpc('ping');
  }

  prepare(sql) {
    const db = this;
    return {
      get(...params) {
        return db.#query(sql, params, 'get');
      },
      all(...params) {
        return db.#query(sql, params, 'all');
      },
      run(...params) {
        return db.#query(sql, params, 'run');
      }
    };
  }

  exec(sql) {
    this.#rpc('exec', { sql: translateSchemaSql(sql) });
    return this;
  }

  pragma() {
    return undefined;
  }

  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction() expects a function');
    return (...args) => {
      const outermost = this.transactionDepth === 0;
      if (outermost) this.#rpc('begin');
      this.transactionDepth += 1;
      try {
        const value = fn(...args);
        this.transactionDepth -= 1;
        if (outermost) this.#rpc('commit');
        return value;
      } catch (error) {
        this.transactionDepth -= 1;
        if (outermost) {
          try { this.#rpc('rollback'); } catch {}
        }
        throw error;
      }
    };
  }

  close() {
    if (this.closed) return;
    try { this.#rpc('close'); } catch {}
    this.closed = true;
    void this.worker.terminate();
  }

  #query(sql, params, mode) {
    const pragma = parseTableInfoPragma(sql);
    if (pragma) {
      if (mode === 'run') return { changes: 0 };
      const rows = this.#rpc('query', {
        sql: `SELECT column_name AS name
              FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = $1
              ORDER BY ordinal_position`,
        params: [pragma.table]
      }).rows;
      return mode === 'get' ? rows[0] : rows;
    }

    const translated = translateQuerySql(sql);
    const result = this.#rpc('query', {
      sql: translated.sql,
      params: normalizeParams(params)
    });

    if (mode === 'get') return result.rows[0];
    if (mode === 'all') return result.rows;
    return { changes: Number(result.rowCount || 0) };
  }

  #rpc(op, payload = {}) {
    if (this.closed && op !== 'close') throw new Error('Database is closed');

    const sab = new SharedArrayBuffer(RPC_BUFFER_BYTES);
    const control = new Int32Array(sab, 0, 4);
    this.worker.postMessage({ op, ...payload, sab });

    const wait = Atomics.wait(control, 0, 0, RPC_TIMEOUT_MS);
    if (wait === 'timed-out') throw new Error(`Database operation timed out after ${RPC_TIMEOUT_MS}ms (${op})`);

    const status = Atomics.load(control, 1);
    const length = Atomics.load(control, 2);
    const bytes = new Uint8Array(sab, 16, length);
    const raw = decoder.decode(bytes);
    const message = raw ? JSON.parse(raw) : {};

    if (status !== 1) {
      const error = new Error(message.message || 'Postgres operation failed');
      if (message.code) error.code = message.code;
      if (message.detail) error.detail = message.detail;
      if (message.constraint) error.constraint = message.constraint;
      throw error;
    }
    return message.result;
  }
}

function normalizeParams(params) {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'bigint') return value.toString();
    return value;
  });
}

function parseTableInfoPragma(sql) {
  const match = String(sql).trim().match(/^PRAGMA\s+table_info\(\s*["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s*\)\s*;?$/i);
  return match ? { table: match[1] } : null;
}

function translateSchemaSql(sql) {
  let text = String(sql);
  text = text.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGSERIAL PRIMARY KEY');
  text = text.replace(/\bALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi, 'ALTER TABLE $1 ADD COLUMN IF NOT EXISTS ');
  return text;
}

function translateQuerySql(sql) {
  let text = String(sql);
  let ignoreConflict = false;

  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(text)) {
    ignoreConflict = true;
    text = text.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, (match) => match.replace(/OR\s+IGNORE\s+/i, ''));
  }

  text = translateSchemaSql(text);
  const translated = replaceQuestionPlaceholders(text);
  text = translated.sql;

  if (ignoreConflict && !/\bON\s+CONFLICT\b/i.test(text)) {
    const semicolon = /;\s*$/.test(text);
    text = text.replace(/;\s*$/, '');
    text += ' ON CONFLICT DO NOTHING';
    if (semicolon) text += ';';
  }

  return { sql: text, placeholders: translated.count };
}

function replaceQuestionPlaceholders(sql) {
  let result = '';
  let count = 0;
  let state = 'normal';

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (state === 'single') {
      result += ch;
      if (ch === "'" && next === "'") { result += next; i += 1; continue; }
      if (ch === "'") state = 'normal';
      continue;
    }
    if (state === 'double') {
      result += ch;
      if (ch === '"' && next === '"') { result += next; i += 1; continue; }
      if (ch === '"') state = 'normal';
      continue;
    }
    if (state === 'line-comment') {
      result += ch;
      if (ch === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      result += ch;
      if (ch === '*' && next === '/') { result += next; i += 1; state = 'normal'; }
      continue;
    }

    if (ch === "'") { state = 'single'; result += ch; continue; }
    if (ch === '"') { state = 'double'; result += ch; continue; }
    if (ch === '-' && next === '-') { state = 'line-comment'; result += ch + next; i += 1; continue; }
    if (ch === '/' && next === '*') { state = 'block-comment'; result += ch + next; i += 1; continue; }
    if (ch === '?') { count += 1; result += `$${count}`; continue; }
    result += ch;
  }

  return { sql: result, count };
}

export const __test = {
  parseTableInfoPragma,
  replaceQuestionPlaceholders,
  translateQuerySql,
  translateSchemaSql
};
