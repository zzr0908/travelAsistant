import { fetch as request, ProxyAgent } from 'undici';
import { AppError, ensure } from '../service/domain/validation.js';
import type { DB } from '../storage/database.js';

export interface MapTransportOptions {
  apiKey?: string;
  proxyUrl?: string;
  dailyBudget?: number;
  timeoutMs?: number;
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
}
export interface MapBytes { bytes: Buffer; mime: string; cached: boolean; estimatedCredits: number }
interface Flight { controller: AbortController; promise: Promise<MapBytes>; readers: number }
interface Slot { query: boolean; signal: AbortSignal; resolve(): void; reject(reason: unknown): void; abort(): void }
const abortError = () => new DOMException('地图请求已取消', 'AbortError');
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(abortError());
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
  const abort = () => { done(); reject(abortError()); };
  const timer = setTimeout(() => { done(); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

export class MapTransport {
  private apiKey: string;
  private dispatcher?: ProxyAgent;
  private shutdown = new AbortController();
  private nextSlot = 0;
  private slots: Slot[] = [];
  private slotTimer?: ReturnType<typeof setTimeout>;
  private queryStreak = 0;
  private flights = new Map<string, Flight>();
  private cache = new Map<string, { value: MapBytes; until: number }>();
  private cacheBytes = 0;
  readonly dailyBudget: number;
  readonly timeoutMs: number;
  constructor(private db: DB, private options: MapTransportOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GEOAPIFY_API_KEY ?? '';
    const proxyUrl = options.proxyUrl ?? process.env.MAPS_PROXY_URL;
    this.dailyBudget = Math.max(0, options.dailyBudget ?? Number(process.env.MAPS_DAILY_BUDGET || 2800));
    ensure(Number.isFinite(this.dailyBudget), '地图每日预算配置无效');
    this.timeoutMs = Math.min(10000, Math.max(50, options.timeoutMs ?? 10000));
    if (proxyUrl && !options.fetch) this.dispatcher = new ProxyAgent(proxyUrl);
  }
  get available() { return !!this.apiKey && !this.shutdown.signal.aborted; }
  usage() {
    const row = this.db.prepare('SELECT credits,requests FROM map_usage WHERE day=?').get(new Date().toISOString().slice(0, 10)) as { credits: number; requests: number } | undefined;
    return { credits: row?.credits || 0, requests: row?.requests || 0, dailyBudget: this.dailyBudget };
  }
  private debit(credits: number) {
    this.db.transaction(() => {
      const day = new Date().toISOString().slice(0, 10), current = this.usage();
      ensure(current.credits + credits <= this.dailyBudget, '地图今日预算已达阈值；已保存内容仍可查看', 429, 'MAP_BUDGET');
      this.db.prepare('INSERT INTO map_usage(day,credits,requests) VALUES(?,?,1) ON CONFLICT(day) DO UPDATE SET credits=credits+excluded.credits,requests=requests+1').run(day, credits);
    })();
  }
  private dispatchSlot() {
    if (this.slotTimer) return;
    if (!this.slots.length) return;
    const wait = this.nextSlot - Date.now();
    if (wait > 0) {
      this.slotTimer = setTimeout(() => { this.slotTimer = undefined; this.dispatchSlot(); }, wait);
      return;
    }
    // Queries get prompt access during tile bursts; every fourth slot remains
    // available to waiting resources. All classes and retries share the limit.
    const query = this.slots.findIndex(slot => slot.query), resource = this.slots.findIndex(slot => !slot.query);
    const index = query >= 0 && (this.queryStreak < 3 || resource < 0) ? query : resource;
    const slot = this.slots.splice(index, 1)[0];
    slot.signal.removeEventListener('abort', slot.abort);
    this.queryStreak = slot.query ? this.queryStreak + 1 : 0;
    this.nextSlot = Date.now() + 260;
    slot.resolve();
    this.dispatchSlot();
  }
  private slot(signal: AbortSignal, query: boolean) {
    // Cancelled waiters leave immediately and never reserve budget.
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      const slot: Slot = { query, signal, resolve, reject, abort: () => {
        const index = this.slots.indexOf(slot);
        if (index < 0) return;
        this.slots.splice(index, 1);
        signal.removeEventListener('abort', slot.abort);
        if (!this.slots.length && this.slotTimer) { clearTimeout(this.slotTimer); this.slotTimer = undefined; }
        reject(abortError());
      } };
      this.slots.push(slot);
      signal.addEventListener('abort', slot.abort, { once: true });
      this.dispatchSlot();
    });
  }
  private async download(base: string, credits: number, signal: AbortSignal): Promise<MapBytes> {
    ensure(this.available, '地图服务尚未配置；已有图文计划仍可查看', 503, 'MAP_UNAVAILABLE');
    const target = new URL(base);
    ensure(['https://maps.geoapify.com', 'https://api.geoapify.com'].includes(target.origin) && !target.username && !target.password, '地图来源不受支持');
    target.searchParams.set('apiKey', this.apiKey);
    let spent = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.slot(signal, target.origin === 'https://api.geoapify.com');
      if (signal.aborted) throw abortError();
      this.debit(credits); spent += credits;
      try {
        const response = this.options.fetch ? await this.options.fetch(target.toString(), { signal }) : await request(target, { dispatcher: this.dispatcher, signal, redirect: 'error' });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403) throw new AppError(503, '地图服务鉴权失败，请检查服务配置', 'MAP_AUTH');
          if (response.status === 429 || response.status >= 500) {
            if (attempt === 0) {
              const retryAfter = Number(response.headers.get('retry-after'));
              await pause(Math.min(1500, Math.max(500, Number.isFinite(retryAfter) ? retryAfter * 1000 : 500)), signal);
              continue;
            }
            throw new AppError(503, response.status === 429 ? '地图服务请求较多，请稍后重试' : '地图供应商暂时不可用', response.status === 429 ? 'MAP_RATE' : 'MAP_UPSTREAM');
          }
          throw new AppError(502, response.status === 404 ? '该地图资源暂无结果' : '地图查询未能完成，请检查地点和范围', 'MAP_UPSTREAM');
        }
        const length = Number(response.headers.get('content-length') || 0);
        ensure(length <= 8 * 1024 * 1024, '地图结果过大，请缩小范围', 502, 'MAP_TOO_LARGE');
        const chunks: Uint8Array[] = []; let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const part = await reader.read(); if (part.done) break;
              size += part.value.byteLength;
              if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new AppError(502, '地图结果过大，请缩小范围', 'MAP_TOO_LARGE'); }
              chunks.push(part.value);
            }
          } finally { reader.releaseLock(); }
        }
        return { bytes: Buffer.concat(chunks), mime: response.headers.get('content-type') || 'application/octet-stream', cached: false, estimatedCredits: spent };
      } catch (error) {
        if (error instanceof AppError || signal.aborted) throw error;
        if (!attempt) { await pause(500, signal); continue; }
        // Never propagate fetch errors: their cause may contain the credential URL.
        throw new AppError(503, '地图网络暂时不可用，请稍后重试', 'MAP_NETWORK');
      }
    }
    throw new AppError(503, '地图查询未完成', 'MAP_UPSTREAM');
  }
  async get(url: string, credits: number, key: string, options: { signal?: AbortSignal; cacheMs?: number } = {}): Promise<MapBytes> {
    ensure(!this.shutdown.signal.aborted, '地图服务已关闭', 503, 'MAP_UNAVAILABLE');
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) {
      if (options.signal?.aborted) throw abortError();
      this.cache.delete(key); this.cache.set(key, cached);
      return { ...cached.value, cached: true, estimatedCredits: 0 };
    }
    if (cached) { this.cacheBytes -= cached.value.bytes.length; this.cache.delete(key); }
    let flight = this.flights.get(key), joined = !!flight;
    if (flight?.controller.signal.aborted) { this.flights.delete(key); flight = undefined; joined = false; }
    if (!flight) {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)]);
      const item: Flight = { controller, readers: 0, promise: Promise.resolve(null as never) };
      item.promise = this.download(url, credits, signal).then(value => {
        if (options.cacheMs && !signal.aborted) {
          this.cache.set(key, { value, until: Date.now() + options.cacheMs }); this.cacheBytes += value.bytes.length;
          while (this.cacheBytes > 64 * 1024 * 1024 || this.cache.size > 512) {
            const oldest = this.cache.keys().next().value!;
            this.cacheBytes -= this.cache.get(oldest)!.value.bytes.length; this.cache.delete(oldest);
          }
        }
        return value;
      }).catch(error => {
        if (signal.aborted) throw new AppError(503, controller.signal.aborted || this.shutdown.signal.aborted ? '地图查询已取消' : '地图请求超时，请重试；图文仍可查看', controller.signal.aborted ? 'MAP_CANCELLED' : 'MAP_TIMEOUT');
        throw error;
      }).finally(() => { if (this.flights.get(key) === item) this.flights.delete(key); });
      this.flights.set(key, item); flight = item;
    }
    flight.readers++;
    const current = flight;
    return new Promise<MapBytes>((resolve, reject) => {
      let ended = false;
      const end = () => {
        if (ended) return false;
        ended = true; options.signal?.removeEventListener('abort', abort);
        current.readers--; if (!current.readers && this.flights.get(key) === current) current.controller.abort();
        return true;
      };
      const abort = () => { if (end()) reject(abortError()); };
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(value => { if (end()) resolve(joined ? { ...value, cached: true, estimatedCredits: 0 } : value); }, error => { if (end()) reject(error); });
    });
  }
  async json(url: string, credits: number, key: string, signal?: AbortSignal) {
    const response = await this.get(url, credits, key, { signal });
    try { return { ...response, data: JSON.parse(response.bytes.toString('utf8')) as unknown }; }
    catch { throw new AppError(502, '地图结果格式异常，请稍后重试', 'MAP_FORMAT'); }
  }
  async close() {
    this.shutdown.abort();
    await Promise.allSettled([...this.flights.values()].map(f => f.promise));
    this.cache.clear(); this.cacheBytes = 0;
    await this.dispatcher?.close();
  }
}
