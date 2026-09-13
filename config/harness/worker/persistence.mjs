import { harnessImport } from '../travel/modules.mjs';
import { resources } from './resources.mjs';
const p = await harnessImport('@deepseek-ai/dsh-session-persistence');
const s = await harnessImport('@deepseek-ai/dsh-session');
export default class RemoteSessionPersistence extends p.SessionPersistence {
  static inject = ['travelWorker'];
  handles = new Set();
  constructor(ctx) {
    super(ctx);
    const writer = id => [...this.handles].find(h => h.id === id && h.access === 'write');
    ctx.on('session/event', (session, event) => { void writer(session.id)?.append([event]).catch(() => {}); });
    ctx.on('session/flush', session => writer(session.id)?.flush());
    ctx.on('session/disposed', session => writer(session.id)?.close());
    ctx.effect(() => () => Promise.allSettled([...this.handles].map(h => h.close())));
  }
  call(id, method, value) { return resources.worker.sessionCall(id, `session.${method}`, value); }
  async create(header, options = {}) {
    options.signal?.throwIfAborted();
    const snapshot = p.materializeCreateHeader(header); p.assertVersion(snapshot);
    const inheritedCount = options.inheritedEventCount || 0;
    if ((snapshot.isSeeded && options.inheritedEventCount === undefined) || (!snapshot.isSeeded && inheritedCount !== 0)) throw new Error('Invalid inherited event count');
    await this.call(snapshot.id, 'create', { header: snapshot, inheritedCount });
    return this.open(snapshot.id, 'write', options);
  }
  async open(id, access, options = {}) {
    options.signal?.throwIfAborted();
    if (!['read', 'write'].includes(access)) throw new Error('Invalid access mode');
    if (access === 'write' && [...this.handles].some(h => h.id === id && h.access === 'write')) throw new p.SessionAlreadyOwnedError(id);
    const row = await this.call(id, 'read', {});
    if (!row) throw new p.SessionPersistenceNotFoundError(id);
    const header = row.header; p.assertVersion(header); p.assertStoredId(id, header);
    let events = [...p.validateStoredEvents(header, row.events)]; p.assertContiguous(id, events, 0);
    let closed = false, tail = Promise.resolve(), failure;
    const assertOpen = signal => { signal?.throwIfAborted(); if (closed) throw new p.SessionHandleClosedError(id); };
    const assertWrite = () => { if (access !== 'write') throw new p.SessionReadOnlyError(id, 'write'); if (failure) throw failure; };
    const handle = { id, access, header: Object.freeze(header), inheritedEventCount: s.SessionLogOffset(row.inheritedCount),
      read: async (offset = 0, length, opts = {}) => { assertOpen(opts.signal); await tail; s.SessionLogOffset(offset); if (length !== undefined) s.SessionLogOffset(length); return events.slice(offset, length === undefined ? undefined : offset + length); },
      append: (input, opts = {}) => {
        assertOpen(opts.signal); assertWrite(); const batch = p.materializeAppendBatch(input);
        tail = tail.then(async () => {
          assertWrite(); p.assertContiguous(id, batch, events.length); p.validateStoredEvents(header, batch);
          await this.call(id, 'append', { events: batch }); events.push(...batch);
        }).catch(error => { failure = error; throw error; });
        void tail.catch(() => {}); return tail;
      },
      flush: async (opts = {}) => { assertOpen(opts.signal); assertWrite(); await tail; },
      close: async () => { if (closed) return; try { await tail; if (failure) throw failure; } finally { closed = true; this.handles.delete(handle); } },
      [Symbol.asyncDispose]: async () => handle.close(),
    };
    this.handles.add(handle); return handle;
  }
  async flush() { for (const handle of this.handles) if (handle.access === 'write') await handle.flush(); }
  async stat(id, options = {}) { options.signal?.throwIfAborted(); const row = await this.call(id, 'read', {}); return row ? { header: row.header, revision: p.SessionPersistenceRevision(`${id}:${row.events.length}`), eventCount: row.events.length } : undefined; }
  async list() { return Promise.all([...new Set([...this.handles].map(h => h.id))].map(id => this.stat(id))); }
}
