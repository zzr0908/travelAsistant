import type {AgentRunView} from './agent.js';
import type {NoteFields} from './notes.js';
const labels={source_supported:'来源支持',user_provided:'用户提供',suggestion:'建议／估计',unknown:'待核对',conflict:'来源冲突'};
export function researchNote(run:AgentRunView):NoteFields {
  if(!run.output)throw new Error('这次研究还没有可保存的结果');
  const evidence=run.output.claims.map(claim=>[
    `- ${labels[claim.status]}：${claim.text}`,
    claim.appliesTo && `  适用条件：${claim.appliesTo}`,
    claim.url && `  来源：${claim.url}`,
    claim.retrievedAt && `  查阅时间：${claim.retrievedAt}`,
    claim.limitations?.length && `  读取限制：${claim.limitations.join('；')}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  const body=[run.output.answer,...run.output.candidates.map(c=>`## ${c.title}\n\n${c.description}\n\n取舍：${c.tradeoffs}`),evidence && `## 来源与待核对事项\n\n${evidence}`].filter(Boolean).join('\n\n');
  const targetNames=(run.researchPlaceIds || []).flatMap(id=>run.spatial?.find(asset=>asset.id===id)?.name || []);
  return {title:(targetNames.length ? `${targetNames.join('、')} · 研究笔记` : run.prompt.trim()).slice(0,160) || '研究笔记',body,nodeIds:[],preparationIds:[],mediaIds:[...new Set(run.output.media.map(ref=>ref.mediaId))].filter(id=>run.media.some(asset=>asset.id===id&&asset.status==='ready')),spatialIds:[...new Set([...(run.researchPlaceIds || []),...run.output.spatial.map(ref=>ref.assetId)])].slice(0,50)};
}
