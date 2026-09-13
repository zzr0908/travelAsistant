import {routeSearchCenters} from '../shared/route-nearby.js';
import {workspaceMediaIds} from '../shared/notes.js';
import type { DB } from './database.js';
import { ensure, validateData } from '../service/domain/validation.js';
import { MapStore, mapCanonical } from '../maps/store.js';
import { digest } from '../shared/hash.js';
import { mapInputSchema, mapQueryResultSchema, spatialBindingSchema, spatialReferenceSchema, spatialSummary } from '../shared/maps.js';
import type { WorkspaceData } from '../shared/model.js';
import { emptyPublication, publicationHistory, type PublishedReferences } from './publication-history.js';

export const mapTables = ['map_queries', 'spatial_assets', 'agent_map_queries', 'map_usage'];
export function inspectMapBackup(db: DB) {
  const store = new MapStore(db);
  const inspect = (data: WorkspaceData) => { validateData(data); store.validate(data); };
  const history = publicationHistory(db,w => inspect(w.data));
  const permitted = (ids: string[], media: string[], owner: string, publication: PublishedReferences, message: string) => {
    history.assertOwnedOrPublished({spatial:new Set(ids),media:new Set(media)},owner,publication,message);
  };
  const inspectSummaries = (values: any[] = [], owner: string, publication: PublishedReferences) => {
    for (const summary of values) {
      const asset = store.get(summary.id);
      ensure(mapCanonical(summary) === mapCanonical(spatialSummary(asset)), '研究上下文中的地图摘要与保存资产不一致');
      permitted([asset.id],[],owner,publication,'研究上下文地图引用不属于本人或历史发布范围');
    }
  };
  const inspectMedia = (values: any[] = [], owner: string, publication: PublishedReferences) => {
    for (const image of values) {
      const id = image.id || image.mediaId;
      ensure(id && (!image.id || !image.mediaId || image.id === image.mediaId),'研究配图标识不一致');
      permitted([], [id], owner, publication, '研究配图不属于本人或历史发布范围');
      const row = db.prepare('SELECT metadata FROM media_assets WHERE id=?').get(id) as {metadata:string};
      const saved = JSON.parse(row.metadata);
      ensure(saved.status === 'ready','研究引用的配图未成功保存');
      if (image.sha256 !== undefined) ensure(image.sha256 === saved.sha256,'研究配图摘要与保存图片不一致');
    }
  };
  const inspectRefs = (values: unknown[] = [], owner: string, publication: PublishedReferences) => {
    for (const value of values) {
      const ref = spatialReferenceSchema.parse(value);
      permitted([ref.assetId],ref.mediaIds,owner,publication,'回答空间引用不属于本人或本次研究的历史发布范围');
    }
  };
  for (const q of db.prepare('SELECT * FROM map_queries').all() as { id:string;owner_id:string;request_id:string;request_hash:string;workspace_id:string|null;input:string;result:string|null;created:string }[]) {
    const input = mapInputSchema.parse(JSON.parse(q.input));
    ensure(input.requestId === q.request_id && (input.workspaceId || null) === q.workspace_id && digest(mapCanonical(input)) === q.request_hash, '地图查询标识或参数校验失败');
    const inputIds = [input.placeId,input.nearPlaceId,...(input.placeIds || [])].filter(Boolean) as string[];
    for (const id of inputIds) ensure(store.get(id).kind === 'place','地图查询输入的地点缺失或类型无效');
    permitted(inputIds,[],q.owner_id,history.at(q.workspace_id,q.created),'地图查询输入引用了当时未发布的私人地点');
    if(input.nearRouteId){
      permitted([input.nearRouteId],[],q.owner_id,history.at(q.workspace_id,q.created),'沿途查询引用未授权路线');
      ensure(routeSearchCenters(store.get(input.nearRouteId))[input.routeCenterIndex!],'沿途查询位置无效');
    }
    if (q.result) {
      const r = mapQueryResultSchema.parse(JSON.parse(q.result));
      ensure(r.queryId === q.id, '地图结果查询关联无效');
      ensure(['ok','ambiguous'].includes(r.status) || r.assets.length === 0,'未成功地图查询不应包含已核实资产');
      for (const asset of r.assets) {
        ensure(mapCanonical(store.get(asset.id)) === mapCanonical(asset), '地图结果与保存资产不一致');
        ensure(store.row(asset.id).owner_id === q.owner_id, '地图查询引用了他人的私人资产');
      }
    }
  }
  for (const row of db.prepare('SELECT a.id,a.owner_id,a.query_id,q.owner_id AS query_owner,q.input,q.result FROM spatial_assets a JOIN map_queries q ON q.id=a.query_id').all() as {id:string;owner_id:string;query_id:string;query_owner:string;input:string;result:string|null}[]) {
    const asset = store.get(row.id), input = mapInputSchema.parse(JSON.parse(row.input));
    ensure(asset.id === row.id && asset.source.queryId === row.query_id && row.owner_id === row.query_owner, '空间资产标识或归属无效');
    const origin = row.result ? mapQueryResultSchema.parse(JSON.parse(row.result)) : null;
    ensure(origin?.assets.some(a=>mapCanonical(a) === mapCanonical(asset)), '空间资产缺少来源查询的成功返回');
    for (const id of asset.route?.placeIds || []) ensure(store.get(id).kind === 'place', '路径引用的地点缺失或类型无效');
    if (asset.route) ensure(mapCanonical(asset.route.placeIds) === mapCanonical(input.placeIds) && input.action === (asset.route.mode === 'schematic' ? 'schematic' : 'route'),'路径的地点顺序与来源查询不一致');
  }
  for (const row of db.prepare('SELECT q.owner_id AS query_owner,q.workspace_id,r.owner_id AS run_owner,r.scope FROM agent_map_queries a JOIN map_queries q ON q.id=a.query_id JOIN agent_runs r ON r.id=a.run_id').all() as {query_owner:string;workspace_id:string|null;run_owner:string;scope:string}[]) {
    ensure(row.query_owner === row.run_owner && row.workspace_id === (JSON.parse(row.scope).workspaceId || null), '研究地图查询归属或范围无效');
  }
  const inspectProposal = (proposal: any, owner: string) => {
    inspect(proposal.workspace.data);
    const published = proposal.before ? history.exact(proposal.before) : emptyPublication();
    permitted([...store.ids(proposal.workspace.data)],workspaceMediaIds(proposal.workspace.data),owner,published,'提议引用了没有历史发布依据的私人地图／配图');
    for (const claim of proposal.claims || []) if (claim.spatialEvidence) permitted([claim.spatialEvidence.assetId],[],owner,published,'提议地图来源不属于本人或历史发布范围');
  };
  for (const row of db.prepare('SELECT p.body,r.owner_id FROM agent_proposals p JOIN agent_runs r ON r.id=p.run_id').all() as {body:string;owner_id:string}[]) inspectProposal(JSON.parse(row.body),row.owner_id);
  for (const row of db.prepare('SELECT rowid,id,session_id,owner_id,scope,context,output FROM agent_runs ORDER BY rowid').all() as {rowid:number;id:string;session_id:string;owner_id:string;scope:string;context:string;output:string|null}[]) {
    const scope = JSON.parse(row.scope), context = JSON.parse(row.context), base = context.base;
    const publishedAtStart = base ? history.exact(base) : emptyPublication();
    ensure(!base || base.id === scope.workspaceId,'研究地图快照与授权范围不一致');
    const inspectContext = (part: any) => {
      if (!part) return;
      inspectRefs(Array.isArray(part.spatial) ? part.spatial : Object.values(part.spatial || {}).flat(),row.owner_id,publishedAtStart);
      inspectSummaries(part.spatialAssets || part.assets,row.owner_id,publishedAtStart);
      inspectMedia(Array.isArray(part.media) ? part.media : Object.values(part.media || {}).flat(),row.owner_id,publishedAtStart);
    };
    if (context.projection) {
      ensure(base && context.projection.workspaceId === base.id && context.projection.version === base.version,'研究投影与历史计划范围不一致');
      for (const [nodeId,bindings] of Object.entries(context.projection.spatial || {})) {
        ensure(mapCanonical(bindings) === mapCanonical(base.data.spatial?.[nodeId]),'研究投影中的空间关联与历史版本不一致');
        for (const value of bindings as unknown[]) {const binding=spatialBindingSchema.parse(value);permitted([binding.assetId],binding.mediaIds,row.owner_id,publishedAtStart,'研究投影包含未授权地图或配图');}
      }
      inspectSummaries(context.projection.spatialAssets,row.owner_id,publishedAtStart);
      inspectMedia(Object.values(context.projection.media || {}).flat(),row.owner_id,publishedAtStart);
    }
    if(context.researchPlaceIds){
      ensure(Array.isArray(context.researchPlaceIds)&&context.researchPlaceIds.length<=10&&new Set(context.researchPlaceIds).size===context.researchPlaceIds.length,'研究目标引用无效');
      ensure(mapCanonical(context.researchPlaceIds)===mapCanonical((context.researchPlaces || []).map((a:any)=>a.id)),'研究目标与摘要不一致');
      inspectSummaries(context.researchPlaces,row.owner_id,publishedAtStart);
    }
    inspectContext(context.selectedCandidate);
    for (const [index,previous] of (context.previousRuns || []).entries()) {
      inspectContext(previous);
      const retained = previous.retainedResearch;
      if (retained) {
        const prior = retained.sourceRunId ? db.prepare('SELECT id FROM agent_runs WHERE id=? AND session_id=? AND rowid<?').get(retained.sourceRunId,row.session_id,row.rowid) as {id:string}|undefined : db.prepare('SELECT id FROM agent_runs WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT 1').get(row.session_id,row.rowid) as {id:string}|undefined;
        ensure(prior && (retained.sourceRunId || index === context.previousRuns.length-1) && retained.spatialAssets.length <= 24 && retained.media.length <= 12,'保留研究上下文的来源或数量无效');
        ensure(!retained.pages || (Array.isArray(retained.pages)&&retained.pages.length<=6),'保留正文数量无效');
        for(const page of retained.pages || []){
          const query=db.prepare('SELECT q.result FROM browser_queries q JOIN agent_browser_queries a ON a.query_id=q.id WHERE a.run_id=? AND q.id=? AND q.owner_id=?').get(prior.id,page.queryId,row.owner_id) as {result:string|null}|undefined;
          const saved=query?.result ? JSON.parse(query.result) : null;
          ensure(saved?.data && page.text===saved.data.text.slice(0,3000) && page.url===saved.data.url && page.title===saved.data.title && page.retrievedAt===saved.retrievedAt && page.status===saved.status && mapCanonical(page.limitations)===mapCanonical(saved.limitations) && page.truncated===(saved.data.truncated||saved.data.text.length>3000),'保留正文与原始查询不一致');
        }
        inspectSummaries(retained.spatialAssets,row.owner_id,emptyPublication()); inspectMedia(retained.media,row.owner_id,emptyPublication());
        const acquired = new Set((db.prepare('SELECT q.result FROM map_queries q JOIN agent_map_queries a ON a.query_id=q.id WHERE a.run_id=?').all(prior.id) as {result:string|null}[]).flatMap(q=>q.result ? mapQueryResultSchema.parse(JSON.parse(q.result)).assets.map(a=>a.id) : []));
        for (const asset of retained.spatialAssets) ensure(acquired.has(asset.id),'保留地图不属于上一轮已保存研究');
        for (const media of retained.media) ensure(db.prepare('SELECT 1 FROM agent_run_media WHERE run_id=? AND media_id=?').get(prior.id,media.id),'保留图片不属于上一轮已保存研究');
      }
    }
    if (row.output) {
      const saved = JSON.parse(row.output);
      inspectRefs(saved.output?.spatial,row.owner_id,publishedAtStart);
      inspectMedia(saved.output?.media,row.owner_id,publishedAtStart);
      for (const claim of saved.claims || []) if (claim.spatialEvidence) permitted([claim.spatialEvidence.assetId],[],row.owner_id,publishedAtStart,'回答地图来源不属于本人或历史发布范围');
      if (saved.proposal) inspectProposal(saved.proposal,row.owner_id);
    }
  }
  for (const row of db.prepare('SELECT day,credits,requests FROM map_usage').all() as {day:string;credits:number;requests:number}[]) ensure(/^\d{4}-\d{2}-\d{2}$/.test(row.day) && Number.isFinite(row.credits) && row.credits >= 0 && Number.isInteger(row.requests) && row.requests >= 0,'地图用量记录无效');
}
