import { workspaceMediaIds } from '../shared/notes.js';
import type { DB } from './database.js';
import { digest } from '../shared/hash.js';
import { ensure, validateData } from '../service/domain/validation.js';
import type { WorkspaceData } from '../shared/model.js';
import { z } from 'zod';
export const mediaTables = ['media_assets', 'agent_run_media'];
const metadata = z.object({ duplicateOf: z.string().uuid().optional(), id: z.string().uuid(), kind: z.enum(['image','screenshot']), status: z.enum(['ready','failed','excluded','reference_only']), url: z.string().url(), sourceUrl: z.string().url(), sourceTitle: z.string(), alt: z.string(), caption: z.string(), retrievedAt: z.string().datetime(), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(), mimeType: z.string().nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), message: z.string(), interpretation: z.literal('not_performed'), license: z.string().nullable() }).strict();
export function inspectMediaBackup(db: DB) {
  const ids = new Set<string>();
  for (const row of db.prepare('SELECT a.*,q.owner_id AS query_owner FROM media_assets a JOIN browser_queries q ON q.id=a.query_id').all() as any[]) {
    const m = metadata.parse(JSON.parse(row.metadata));
    ensure(m.id === row.id && row.owner_id === row.query_owner, '图片归属或标识无效');
    if (m.status === 'ready') {
      ensure(row.bytes && row.thumbnail && m.width && m.height && m.width * m.height <= 40000000 && m.mimeType === 'image/webp' && digest(row.bytes) === row.sha256 && row.sha256 === m.sha256 && digest(row.thumbnail) === row.thumbnail_sha256, '图片或缩略图完整性校验失败'); ids.add(row.id);
    } else ensure(!row.bytes && !row.thumbnail && !row.sha256 && !row.thumbnail_sha256 && !m.sha256, '未成功图片不应包含伪造内容');
  }
  for (const row of db.prepare('SELECT owner_id,metadata FROM media_assets').all() as any[]) { const m = metadata.parse(JSON.parse(row.metadata)); if(m.duplicateOf) ensure(ids.has(m.duplicateOf) && (db.prepare('SELECT owner_id FROM media_assets WHERE id=?').get(m.duplicateOf) as {owner_id:string})?.owner_id === row.owner_id, '重复图片引用无效'); }
  for (const row of db.prepare('SELECT m.*,a.owner_id AS asset_owner,r.owner_id AS run_owner FROM agent_run_media m JOIN media_assets a ON a.id=m.media_id JOIN agent_runs r ON r.id=m.run_id').all() as any[]) ensure(row.asset_owner === row.run_owner, '研究图片归属无效');
  const inspect = (data: WorkspaceData) => { validateData(data); ensure(workspaceMediaIds(data).every(id => ids.has(id)), '计划或历史中的图片关联缺失'); };
  for (const row of db.prepare('SELECT data FROM workspaces').all() as {data:string}[]) inspect(JSON.parse(row.data));
  for (const row of db.prepare('SELECT before_data FROM changes').all() as {before_data:string}[]) for (const w of Object.values(JSON.parse(row.before_data)) as any[]) if (w) inspect(w.data);
  for (const row of db.prepare('SELECT body FROM agent_proposals').all() as {body:string}[]) { const body = JSON.parse(row.body); inspect(body.workspace.data); if (body.before) inspect(body.before.data); }
  for (const row of db.prepare('SELECT output FROM agent_runs WHERE output IS NOT NULL').all() as {output:string}[]) { const saved = JSON.parse(row.output); for (const m of saved.output?.media || []) ensure(ids.has(m.mediaId), '回答引用的图片缺失'); if (saved.proposal) inspect(saved.proposal.workspace.data); }
}
