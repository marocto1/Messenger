import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';

const { Pool, types } = pg;
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1700, (value) => Number(value));

const pool = new Pool({
  connectionString: workerData.connectionString,
  max: Number(process.env.DB_POOL_SIZE || 4),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000
});

let transactionClient = null;
const encoder = new TextEncoder();

parentPort.on('message', (message) => {
  void handle(message);
});

async function handle(message) {
  const { op, sab } = message;
  try {
    let result;
    if (op === 'ping') {
      await pool.query('SELECT 1');
      result = { ok: true };
    } else if (op === 'query') {
      const target = transactionClient || pool;
      const queryResult = await target.query(message.sql, message.params || []);
      result = { rows: queryResult.rows || [], rowCount: Number(queryResult.rowCount || 0) };
    } else if (op === 'exec') {
      const target = transactionClient || pool;
      for (const statement of splitStatements(message.sql)) {
        if (statement.trim()) await target.query(statement);
      }
      result = { ok: true };
    } else if (op === 'begin') {
      if (transactionClient) throw new Error('Nested Postgres transaction is not supported at worker level');
      transactionClient = await pool.connect();
      await transactionClient.query('BEGIN');
      result = { ok: true };
    } else if (op === 'commit') {
      if (!transactionClient) throw new Error('No active transaction');
      const client = transactionClient;
      transactionClient = null;
      try { await client.query('COMMIT'); } finally { client.release(); }
      result = { ok: true };
    } else if (op === 'rollback') {
      if (transactionClient) {
        const client = transactionClient;
        transactionClient = null;
        try { await client.query('ROLLBACK'); } finally { client.release(); }
      }
      result = { ok: true };
    } else if (op === 'close') {
      if (transactionClient) {
        const client = transactionClient;
        transactionClient = null;
        try { await client.query('ROLLBACK'); } catch {} finally { client.release(); }
      }
      await pool.end();
      result = { ok: true };
    } else {
      throw new Error(`Unknown database operation: ${op}`);
    }
    writeResponse(sab, 1, { result });
  } catch (error) {
    writeResponse(sab, 2, {
      message: error?.message || String(error),
      code: error?.code || null,
      detail: error?.detail || null,
      constraint: error?.constraint || null
    });
  }
}

function writeResponse(sab, status, payload) {
  const control = new Int32Array(sab, 0, 4);
  const data = new Uint8Array(sab, 16);
  const bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.length > data.length) {
    const fallback = encoder.encode(JSON.stringify({ message: `Database response exceeded ${data.length} bytes` }));
    data.set(fallback.subarray(0, data.length));
    Atomics.store(control, 1, 2);
    Atomics.store(control, 2, Math.min(fallback.length, data.length));
  } else {
    data.set(bytes);
    Atomics.store(control, 1, status);
    Atomics.store(control, 2, bytes.length);
  }
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0, 1);
}

function splitStatements(sql) {
  const statements = [];
  let current = '';
  let state = 'normal';

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (state === 'single') {
      current += ch;
      if (ch === "'" && next === "'") { current += next; i += 1; continue; }
      if (ch === "'") state = 'normal';
      continue;
    }
    if (state === 'double') {
      current += ch;
      if (ch === '"' && next === '"') { current += next; i += 1; continue; }
      if (ch === '"') state = 'normal';
      continue;
    }
    if (state === 'line-comment') {
      current += ch;
      if (ch === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      current += ch;
      if (ch === '*' && next === '/') { current += next; i += 1; state = 'normal'; }
      continue;
    }

    if (ch === "'") { state = 'single'; current += ch; continue; }
    if (ch === '"') { state = 'double'; current += ch; continue; }
    if (ch === '-' && next === '-') { state = 'line-comment'; current += ch + next; i += 1; continue; }
    if (ch === '/' && next === '*') { state = 'block-comment'; current += ch + next; i += 1; continue; }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}
