import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseCard, fixedCardDates, type Card } from '../../shared/cards.js';
import { nodeFields, type WorkspaceData } from '../../shared/model.js';
import { ensure } from './validation.js';
import { addNode } from './operations.js';

export const saveCardsPayload=z.object({
  entries:z.array(z.object({card:z.unknown(),createUnder:z.string().optional()}).strict()).min(1).max(20),
  draftId:z.string().uuid().optional(),duplicateConfirmed:z.boolean().default(false),
}).strict();
export function saveCards(data:WorkspaceData,raw:unknown) {
  const payload=saveCardsPayload.parse(raw),entries=payload.entries.map(e=>({...e,card:parseCard(e.card)}));
  ensure(new Set(entries.map(e=>e.card.id)).size===entries.length,'卡片标识重复');
  data.cards ||= {};
  for(const {card,createUnder} of entries) {
    if(!data.cards[card.id]&&card.source.hash&&!payload.duplicateConfirmed)
      ensure(!Object.values(data.cards).some(c=>c.source.hash===card.source.hash),'该材料已导入，请核对已有卡片后明确更新或继续',409,'CARD_DUPLICATE');
    if(createUnder) {
      ensure(card.bindings.length===0,'新建安排不能同时绑定已有安排');
      ensure(card.type!=='lodging','住宿请关联旅行或日期计划，避免生成全天占用');
      const nodeId=randomUUID();
      addNode(data,nodeId,createUnder,nodeFields.parse({title:card.title,kind:'activity',dates:fixedCardDates(card),fixed:true}));
      card.bindings=[{nodeId,mode:'fixed_event'}];
    }
  }
  // Assign the complete batch before checking references; validation/save is in the caller's transaction.
  for(const {card} of entries)data.cards[card.id]=card;
  for(const {card} of entries)for(const binding of card.bindings) {
    ensure(data.nodes[binding.nodeId],'卡片关联的计划不存在');
    if(binding.mode==='fixed_event') {
      data.nodes[binding.nodeId].dates=fixedCardDates(card);
      data.nodes[binding.nodeId].fixed=true;
    }
  }
  return entries.map(e=>e.card);
}
export function mergeCards(source:WorkspaceData,target:WorkspaceData) {
  if(!source.cards)return;
  target.cards ||= {};
  for(const c of Object.values(source.cards)) {
    // Node IDs are already preserved by the existing merge operation.
    const id=target.cards[c.id]?randomUUID():c.id;
    target.cards[id]={...structuredClone(c),id} as Card;
  }
}
