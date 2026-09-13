import { workspaceMediaIds } from '../../shared/notes.js';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { processImage, type ImageProcessor } from '../../shared/image-processing.js';
import type { DB } from '../../storage/database.js';
import type { MediaAsset } from '../../shared/agent.js';
import { Plans } from '../domain/plans.js';
import { ensure } from '../domain/validation.js';
import { BrowserStore, digest } from '../../storage/browser.js';
import { canonicalUrl, defaultHosts, hostMatches, privateAddress } from '../../shared/browser-sources.js';

const limit = 8 * 1024 * 1024;
export function imageIdentity(raw: string) {
  const url = new URL(canonicalUrl(raw));
  for (const key of [...url.searchParams.keys()]) if (/^(w|h|width|height|dpr|fit|crop|auto|quality|q|format)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  // Wikimedia thumbnails embed both the original and the requested width.
  url.pathname = url.pathname.replace('/thumb/', '/').replace(/\/\d+px-[^/]+$/, '');
  return url.href;
}
export function imageExclusion(url: string, text: string) {
  return /\.(svg|gif|ico)(\?|$)/i.test(url) || /(?:^|[\W_])(logo|icon|avatar|banner-ad|ads?|advert(?:isement|ising)?|tracking|pixel|social|sprite)(?:[\W_]|$)/i.test(`${url} ${text}`) || /广告|头像|无关配图|不相关图片/.test(text) ? '已排除标识、广告或装饰图片' : '';
}
export async function downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> { return (await import('../../agent/runtime/image-download.js')).downloadImage(url, signal); }
type AssetRow = { id: string; owner_id: string; query_id: string; metadata: string; bytes: Buffer | null; thumbnail: Buffer | null; sha256: string | null; thumbnail_sha256: string | null };
export class MediaStore {
  constructor(public db: DB, private fetchImage = downloadImage, private process:ImageProcessor = processImage) {}
  row(id: string) { const row = this.db.prepare('SELECT * FROM media_assets WHERE id=?').get(id) as AssetRow | undefined; ensure(row, '找不到图片', 404); return row; }
  metadata(id: string): MediaAsset { return JSON.parse(this.row(id).metadata) as MediaAsset; }
  run(runId: string): MediaAsset[] {
    const media = (this.db.prepare('SELECT a.metadata FROM media_assets a JOIN agent_run_media r ON r.media_id=a.id WHERE r.run_id=? ORDER BY r.rowid').all(runId) as {metadata: string}[]).map(r => JSON.parse(r.metadata) as MediaAsset);
    const run = this.db.prepare('SELECT owner_id,output FROM agent_runs WHERE id=?').get(runId) as {owner_id:string;output:string|null} | undefined;
    const saved = run?.output ? JSON.parse(run.output) : null;
    for (const ref of saved?.output?.media || []) if (!media.some(m => m.id === ref.mediaId)) { const row = this.row(ref.mediaId); if (row.owner_id === run!.owner_id) media.push(JSON.parse(row.metadata)); }
    return media;
  }
  allowed(id: string, owner: string, workspaceId?: string) {
    const row = this.row(id), plans = new Plans(this.db);
    if (workspaceId) {
      const w = plans.access(workspaceId, owner);
      ensure(workspaceMediaIds(w.data).includes(id), '图片尚未公开到这份计划', 403);
    } else {
      ensure(row.owner_id === owner, '无权查看私人图片', 403);
      const runs = this.db.prepare('SELECT r.scope FROM agent_runs r JOIN agent_run_media m ON m.run_id=r.id WHERE m.media_id=? AND r.owner_id=?').all(id, owner) as {scope: string}[];
      ensure(runs.some(r => { const s = JSON.parse(r.scope); try { if (s.workspaceId) plans.access(s.workspaceId, owner, false, true); return true; } catch { return false; } }), '图片所属研究已不可访问', 403);
    }
    return row;
  }
  usable(id: string, owner: string, workspaceId?: string) {
    const row = this.row(id);
    if (row.owner_id !== owner) this.allowed(id, owner, workspaceId); else this.allowed(id, owner);
    ensure((JSON.parse(row.metadata) as MediaAsset).status === 'ready' && row.bytes && row.thumbnail, '图片尚未采集成功');
  }
  private retries = new Map<string, Promise<MediaAsset>>();
  retry(id: string, owner: string) {
    const row = this.allowed(id, owner), m = this.metadata(id);
    if (m.status === 'ready') return Promise.resolve(m);
    ensure(m.status === 'failed' || m.status === 'reference_only', '已过滤图片不能重试');
    if (this.retries.has(id)) return this.retries.get(id)!;
    ensure(this.retries.size < 2, '图片采集忙碌，请稍后重试', 429);
    const work = (async () => {
      try {
        const original = await this.fetchImage(m.url);
        ensure(original.length <= limit, '图片格式或大小无效');
        const {width,height,bytes,thumbnail} = await this.process(original);
        ensure(Math.min(width,height) >= 200 && Math.max(width,height) >= 320 && width / height <= 5 && height / width <= 5, '图片尺寸不适合展示');
        const duplicate = this.db.prepare('SELECT id FROM media_assets WHERE owner_id=? AND sha256=? AND id<>?').get(row.owner_id,digest(bytes),id) as {id:string}|undefined;
        if(duplicate) {
          Object.assign(m,{status:'excluded',message:'重复图片已合并到图集',duplicateOf:duplicate.id});
          this.db.transaction(()=>{this.db.prepare('UPDATE media_assets SET metadata=? WHERE id=?').run(JSON.stringify(m),id);this.db.prepare('INSERT OR IGNORE INTO agent_run_media(run_id,media_id) SELECT run_id,? FROM agent_run_media WHERE media_id=?').run(duplicate.id,id);})();
          return m;
        }
        Object.assign(m,{status:'ready',message:'已保存来源图片；模型未解读图像内容',retrievedAt:new Date().toISOString(),width,height,mimeType:'image/webp',sha256:digest(bytes)});
        this.db.prepare('UPDATE media_assets SET metadata=?,bytes=?,thumbnail=?,sha256=?,thumbnail_sha256=? WHERE id=? AND owner_id=?').run(JSON.stringify(m),bytes,thumbnail,digest(bytes),digest(thumbnail),id,row.owner_id);
        return m;
      } catch (e) {
        m.status = 'failed'; m.message = e instanceof Error && /图片|来源|原图/.test(e.message) ? e.message : '图片采集失败，请稍后重试';
        this.db.prepare('UPDATE media_assets SET metadata=? WHERE id=? AND owner_id=?').run(JSON.stringify(m),id,row.owner_id);
        return m;
      }
    })().finally(() => this.retries.delete(id));
    this.retries.set(id,work);return work;
  }
  async gather(queryId: string, runId: string, owner: string, signal?: AbortSignal) {
    const query = new BrowserStore(this.db).get(owner, queryId), page = query.result?.data;
    ensure(this.db.prepare('SELECT 1 FROM agent_browser_queries WHERE query_id=? AND run_id=? AND owner_id=?').get(queryId, runId, owner), '图片查询不属于这次研究', 403);
    if (!page || !['ok','partial'].includes(query.result!.status)) return [];
    const attach = (id: string) => this.db.prepare('INSERT OR IGNORE INTO agent_run_media(run_id,media_id) VALUES(?,?)').run(runId, id);
    if (query.result?.artifact && this.run(runId).filter(m => m.status === 'ready').length < 12) {
      const artifact = query.result.artifact, identity = `screenshot:${artifact.id}`;
      const previous = this.db.prepare('SELECT id FROM media_assets WHERE owner_id=? AND identity=?').get(owner,identity) as {id:string} | undefined;
      if(previous) attach(previous.id);
      else {
        const original = new BrowserStore(this.db).artifact(owner,artifact.id);ensure(digest(original.bytes) === artifact.sha256, '截图完整性校验失败');
        const {width,height,bytes,thumbnail}=await this.process(original.bytes,signal),id=randomUUID();
        const meta:MediaAsset = {id,kind:'screenshot',status:'ready',url:page.url,sourceUrl:page.url,sourceTitle:page.title,alt:`${page.title} · 网页截图`,caption:'浏览器采集的页面截图，模型未解读图像内容',retrievedAt:query.result.retrievedAt,width,height,mimeType:'image/webp',sha256:digest(bytes),message:'已保存网页截图；模型未解读',interpretation:'not_performed',license:page.license};
        this.db.prepare('INSERT INTO media_assets(id,owner_id,query_id,identity,metadata,sha256,thumbnail_sha256,bytes,thumbnail) VALUES(?,?,?,?,?,?,?,?,?)').run(id,owner,queryId,identity,JSON.stringify(meta),digest(bytes),digest(thumbnail),bytes,thumbnail);attach(id);
      }
    }
    let downloaded = this.run(runId).filter(m => m.status === 'ready').length, pageDownloads = 0;
    for (const ref of page.media.filter(m => m.kind === 'image').slice(0, 30)) {
      signal?.throwIfAborted();
      let identity: string; try { identity = imageIdentity(ref.url); } catch { continue; }
      const existing = this.db.prepare('SELECT id FROM media_assets WHERE owner_id=? AND identity=?').get(owner, identity) as {id: string} | undefined;
      if (existing) { attach(existing.id); const duplicateOf = this.metadata(existing.id).duplicateOf; if(duplicateOf) attach(duplicateOf); continue; }
      const id = randomUUID(), exclusion = imageExclusion(ref.url, ref.alt + ' ' + ref.caption);
      const meta: MediaAsset = { id, kind: 'image', status: exclusion ? 'excluded' : 'reference_only', url: canonicalUrl(ref.url), sourceUrl: page.url, sourceTitle: page.title, alt: ref.alt, caption: ref.caption, retrievedAt: query.result!.retrievedAt, width: null, height: null, mimeType: null, sha256: null, message: exclusion || '仅发现图片链接，尚未保存', interpretation: 'not_performed', license: page.license };
      let bytes: Buffer | null = null, thumbnail: Buffer | null = null;
      if (!exclusion && downloaded < 12 && pageDownloads < 4) {
        pageDownloads++;
        try {
          const original = await this.fetchImage(ref.url, signal); signal?.throwIfAborted();
          ensure(original.length <= limit, '图片超过 8 MB');
          const processed=await this.process(original,signal);
          const w=processed.width,h=processed.height;
          if (Math.min(w, h) < 200 || Math.max(w, h) < 320 || w / h > 5 || h / w > 5) { meta.status = 'excluded'; meta.message = '已排除尺寸过小或长条装饰图片'; }
          else {
            bytes=processed.bytes;thumbnail=processed.thumbnail;
            const duplicate = this.db.prepare('SELECT id FROM media_assets WHERE owner_id=? AND sha256=?').get(owner, digest(bytes)) as {id: string} | undefined;
            if (duplicate) { attach(duplicate.id); meta.status = 'excluded'; meta.message = '重复图片已合并到图集'; meta.duplicateOf = duplicate.id; bytes = null; thumbnail = null; }
            else { Object.assign(meta, { status: 'ready', message: '已保存来源图片；模型未解读图像内容', width: w, height: h, mimeType: 'image/webp', sha256: digest(bytes) }); downloaded++; }
          }
        } catch (error) { meta.status = 'failed'; meta.message = signal?.aborted ? '图片采集中断，可重试' : error instanceof Error && /图片|来源|原图/.test(error.message) ? error.message : '图片暂时无法读取，可重试'; bytes = null; thumbnail = null; }
      }
      this.db.prepare('INSERT INTO media_assets(id,owner_id,query_id,identity,metadata,sha256,thumbnail_sha256,bytes,thumbnail) VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, queryId, identity, JSON.stringify(meta), bytes ? digest(bytes) : null, thumbnail ? digest(thumbnail) : null, bytes, thumbnail); attach(id);
      signal?.throwIfAborted();
    }
    return this.run(runId);
  }
}
