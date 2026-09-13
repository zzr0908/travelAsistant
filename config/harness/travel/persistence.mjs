import { createHash } from 'node:crypto';
import { harnessImport } from './modules.mjs';
import { getResources } from './resources.mjs';
const p = await harnessImport('@deepseek-ai/dsh-session-persistence');
const s = await harnessImport('@deepseek-ai/dsh-session');
const sha = text => createHash('sha256').update(text).digest('hex');
export default class SqliteSessionPersistence extends p.SessionPersistence {
  static inject = ['travelResources'];
  constructor(ctx) {
    super(ctx);
    this.db = getResources().db;
    this.writers = new Set();
    this.handles = new Set();
    this.failures = new Map();
    ctx.on('session/event', (session, event) => {
      const handle = [...this.handles].find(h => h.id === session.id && h.access === 'write');
      if (handle) void handle.append([event]).catch(error => { this.failures.set(session.id, error); });
    });
    ctx.on('session/flush', session => [...this.handles].find(h => h.id === session.id && h.access === 'write')?.flush());
    ctx.on('session/disposed', session => [...this.handles].find(h => h.id === session.id && h.access === 'write')?.close());
    ctx.effect(() => () => Promise.all([...this.handles].map(h => h.close())));
  }
  async create(header, options = {}) {
    options.signal?.throwIfAborted();
    const snapshot = p.materializeCreateHeader(header);
    p.assertVersion(snapshot);
    const inherited = options.inheritedEventCount || 0;
    if ((snapshot.isSeeded && options.inheritedEventCount === undefined) || (!snapshot.isSeeded && inherited !== 0)) throw new Error('Invalid inherited event count');
    if (this.db.prepare('SELECT 1 FROM harness_sessions WHERE id=?').get(snapshot.id)) throw new p.SessionAlreadyExistsError(snapshot.id);
    this.db.prepare('INSERT INTO harness_sessions(id,header,inherited_count) VALUES(?,?,?)').run(snapshot.id, JSON.stringify(snapshot), inherited);
    return this.open(snapshot.id, 'write', options);
  }
  async open(id, access, options = {}) {
    options.signal?.throwIfAborted();
    const row = this.db.prepare('SELECT * FROM harness_sessions WHERE id=?').get(id);
    if (!row) throw new p.SessionPersistenceNotFoundError(id);
    if (!['read', 'write'].includes(access)) throw new Error('Invalid access mode');
    const header = JSON.parse(row.header); p.assertVersion(header); p.assertStoredId(id, header);
    if (access === 'write' && this.writers.has(id)) throw new p.SessionAlreadyOwnedError(id);
    if (access === 'write') this.writers.add(id);
    let closed = false;
    const assertOpen = signal => { signal?.throwIfAborted(); if (closed) throw new p.SessionHandleClosedError(id); };
    const assertWrite = () => { assertOpen(); if (access !== 'write') throw new p.SessionReadOnlyError(id, 'write'); if (!this.writers.has(id)) throw new p.SessionOwnershipLostError(id); if (this.failures.has(id)) throw this.failures.get(id); };
    const readAll = () => {
      const rows = this.db.prepare('SELECT seq,body,sha256 FROM harness_events WHERE session_id=? ORDER BY seq').all(id);
      const events = rows.map(row => { if (sha(row.body) !== row.sha256) throw new Error('Harness event checksum mismatch'); return JSON.parse(row.body); });
      p.assertContiguous(id, events, 0); return p.validateStoredEvents(header, events);
    };
    try { readAll(); } catch (error) { if (access === 'write') this.writers.delete(id); throw error; }
    const handle = { id, header: Object.freeze(header), inheritedEventCount: s.SessionLogOffset(row.inherited_count), access,
      read: async (offset = 0, length, opts = {}) => { assertOpen(opts.signal); s.SessionLogOffset(offset); if (length !== undefined) s.SessionLogOffset(length); return readAll().slice(offset, length === undefined ? undefined : offset + length); },
      append: async (events, opts = {}) => {
        assertOpen(opts.signal); assertWrite();
        const batch = p.materializeAppendBatch(events);
        p.validateStoredEvents(header, [...batch]);
        this.db.transaction(() => {
          const count = this.db.prepare('SELECT count(*) AS n FROM harness_events WHERE session_id=?').get(id).n;
          p.assertContiguous(id, batch, count);
          for (const event of batch) { const body = JSON.stringify(event); this.db.prepare('INSERT INTO harness_events(session_id,seq,body,sha256) VALUES(?,?,?,?)').run(id, event.seq, body, sha(body)); }
        })();
      },
      flush: async (opts = {}) => { assertOpen(opts.signal); assertWrite(); /* SQLite FULL synchronous commits are the durability barrier. */ },
      close: async () => { if (closed) return; closed = true; if (access === 'write') this.writers.delete(id); this.handles.delete(handle); if (this.failures.has(id)) throw this.failures.get(id); },
      [Symbol.asyncDispose]: async () => handle.close(),
    };
    this.handles.add(handle); return handle;
  }
  async flush() { for (const handle of this.handles) if (handle.access === 'write') await handle.flush(); }
  async stat(id, options = {}) {
    options.signal?.throwIfAborted();
    const row = this.db.prepare('SELECT header FROM harness_sessions WHERE id=?').get(id); if (!row) return undefined;
    const header = JSON.parse(row.header); p.assertVersion(header); p.assertStoredId(id, header);
    const count = this.db.prepare('SELECT count(*) AS n FROM harness_events WHERE session_id=?').get(id).n;
    return { header, revision: p.SessionPersistenceRevision(`${id}:${count}`), eventCount: count };
  }
  async list(options = {}) { options.signal?.throwIfAborted(); return Promise.all(this.db.prepare('SELECT id FROM harness_sessions ORDER BY rowid').all().map(row => this.stat(row.id, options))); }
}
