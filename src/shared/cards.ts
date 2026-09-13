import { z } from 'zod';
import { emptyDates, descendants, trail, type Dates, type WorkspaceData } from './model.js';

const text = z.string().trim().max(600).nullable();
const date = z.string().refine(v => /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= '1900-01-01' && v <= '2200-12-31' && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v, '日期无效').nullable();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间应为 HH:mm').nullable();
const timezone = z.string().max(100).refine(v => { try { new Intl.DateTimeFormat('en', {timeZone:v}); return true; } catch { return false; } }, '时区无效，请填写如 Asia/Shanghai').nullable();
export const cardMomentSchema = z.object({date,time,timezone}).strict();
export type CardMoment = z.infer<typeof cardMomentSchema>;
const common = {
  title:z.string().trim().min(1).max(160),
  bookingStatus:z.enum(['unknown','confirmed','cancelled']),
};
export const cardContentSchema = z.discriminatedUnion('type', [
  z.object({...common,type:z.literal('transport'),facts:z.object({mode:z.enum(['flight','train','other']),serviceNumber:text,departurePlace:text,arrivalPlace:text,departure:cardMomentSchema,arrival:cardMomentSchema}).strict()}).strict(),
  z.object({...common,type:z.literal('lodging'),facts:z.object({name:text,address:text,checkIn:date,checkOut:date,checkInFrom:time,checkInUntil:time,timezone}).strict()}).strict(),
  z.object({...common,type:z.literal('reservation'),facts:z.object({place:text.describe('预约场所名称；材料标题中明确给出的场所名称也属于此字段，不能只保留在卡片 title 中。未知为 null。'),address:text,start:cardMomentSchema,end:cardMomentSchema}).strict()}).strict(),
]);
export const cardSourceSchema = z.object({label:z.string().max(250),hash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),evidence:z.record(z.string().max(100),z.string().max(500)).refine(v=>Object.keys(v).length<=30,'出处过多')}).strict();
export const cardBindingSchema = z.object({nodeId:z.string().min(1).max(100),mode:z.enum(['reference','fixed_event'])}).strict();
// Strip only the envelope before parsing the strict content union.
export function parseCard(raw: unknown): Card {
  const envelope=z.object({id:z.string().uuid(),reviewState:z.enum(['pending','reviewed']),source:cardSourceSchema,bindings:z.array(cardBindingSchema).max(100),type:z.unknown(),title:z.unknown(),facts:z.unknown(),bookingStatus:z.unknown()}).strict().parse(raw);
  const {id,reviewState,source,bindings,...content}=envelope;
  return {...cardContentSchema.parse(content),id,reviewState,source,bindings};
}
export type CardContent = z.infer<typeof cardContentSchema>;
export type Card = CardContent & {id:string;reviewState:'pending'|'reviewed';source:z.infer<typeof cardSourceSchema>;bindings:z.infer<typeof cardBindingSchema>[]};
export const cardLabels = {transport:'交通',lodging:'住宿',reservation:'定时预约'};
export function blankCard(type:Card['type']): CardContent {
  const m=()=>({date:null,time:null,timezone:null});
  if(type==='transport')return {type,title:'交通',bookingStatus:'unknown',facts:{mode:'flight',serviceNumber:null,departurePlace:null,arrivalPlace:null,departure:m(),arrival:m()}};
  if(type==='lodging')return {type,title:'住宿',bookingStatus:'unknown',facts:{name:null,address:null,checkIn:null,checkOut:null,checkInFrom:null,checkInUntil:null,timezone:null}};
  return {type,title:'预约',bookingStatus:'unknown',facts:{place:null,address:null,start:m(),end:m()}};
}
export class CardError extends Error {
  status=400;
  constructor(public code:string,public path:string,public objectId:string,message:string){super(message);}
}
function fail(code:string,path:string,id:string,message:string):never {throw new CardError(code,path,id,message);}
function civil(ms:number,zone:string) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(ms).map(p=>[p.type,p.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
}
export function cardInstant(m:CardMoment):number|null {
  if(!m.date||!m.time||!m.timezone)return null;
  const base=Date.parse(`${m.date}T${m.time}:00Z`), offsets=new Set<number>();
  for(const hours of [-36,-12,0,12,36]) {
    const probe=base+hours*3600000,local=civil(probe,m.timezone);
    offsets.add(Date.parse(`${local.date}T${local.time}:00Z`)-probe);
  }
  const matches=[...offsets].map(o=>base-o).filter(ms=>{const p=civil(ms,m.timezone!);return p.date===m.date&&p.time===m.time;});
  if(matches.length!==1)throw new Error('当地时刻不存在或存在夏令时歧义，请核对时间');
  return matches[0];
}
export function fixedCardDates(card:Card):Dates {
  if(card.type==='lodging'||card.reviewState!=='reviewed'||card.bookingStatus==='cancelled')return fail('CARD_NOT_FIXED','bindings',card.id,'住宿、未核对或已取消的卡片只能作为参考');
  const start=card.type==='transport'?card.facts.departure:card.facts.start;
  const end=card.type==='transport'?card.facts.arrival:card.facts.end;
  let a:number|null,b:number|null;
  try { a=cardInstant(start); b=cardInstant(end); } catch(e) {return fail('CARD_TIME_INVALID','facts',card.id,(e as Error).message);}
  if(a===null)return fail('CARD_TIME_REQUIRED','facts',card.id,'加入固定安排前，请核对开始日期、时间和时区');
  if((end.date||end.time||end.timezone)&&b===null)return fail('CARD_TIME_REQUIRED','facts',card.id,'结束信息不完整，请补全后加入固定安排，或仅保存卡片');
  if(card.type==='transport'&&b===null)return fail('CARD_TIME_REQUIRED','facts.arrival',card.id,'交通安排需要完整的到达日期、时间和时区');
  if(b!==null&&b<=a)return fail('CARD_TIME_INVALID','facts',card.id,'结束时刻必须晚于开始时刻');
  const converted=b===null?null:civil(b,start.timezone!);
  return {...emptyDates(),mode:'fixed',start:start.date!,startTime:start.time!,timezone:start.timezone!,end:converted?.date||start.date!,endTime:converted?.time||''};
}
export function validateCards(data:WorkspaceData) {
  if(data.cards===undefined)return;
  if(!data.cards||Array.isArray(data.cards)||Object.keys(data.cards).length>500)fail('CARD_INVALID','cards','', '卡片数据无效或超过 500 张');
  for(const [id,raw] of Object.entries(data.cards)) {
    const c=parseCard(raw);
    if(c.id!==id)fail('CARD_ID_INVALID','id',id,'卡片标识不一致');
    if(new Set(c.bindings.map(b=>b.nodeId)).size!==c.bindings.length)fail('CARD_REFERENCE_INVALID','bindings',id,'卡片关联重复');
    if(c.type==='lodging'&&c.facts.checkIn&&c.facts.checkOut&&c.facts.checkOut<=c.facts.checkIn)fail('CARD_TIME_INVALID','facts.checkOut',id,'离店日期必须晚于入住日期');
    if(c.type!=='lodging') {
      try {
        const a=cardInstant(c.type==='transport'?c.facts.departure:c.facts.start),b=cardInstant(c.type==='transport'?c.facts.arrival:c.facts.end);
        if(a!==null&&b!==null&&b<=a)fail('CARD_TIME_INVALID','facts',id,'结束时刻必须晚于开始时刻');
      } catch(e) {if(e instanceof CardError)throw e;fail('CARD_TIME_INVALID','facts',id,(e as Error).message);}
    }
    for(const b of c.bindings) {
      const n=data.nodes[b.nodeId];
      if(!n)fail('CARD_REFERENCE_INVALID','bindings',id,'卡片关联的计划不存在');
      if(b.mode==='reference')continue;
      const d=fixedCardDates(c);
      if(!n.fixed||Object.keys(d).some(k=>n.dates[k as keyof Dates]!==d[k as keyof Dates]))fail('CARD_TIME_MISMATCH',`nodes.${n.id}.dates`,id,'固定安排时间与卡片不一致，请通过卡片详情同步修改');
      for(const p of trail(data,n.id).slice(0,-1))if(['fixed','window'].includes(p.dates.mode)&&(d.start<p.dates.start||d.end>p.dates.end))fail('CARD_PARENT_RANGE',`nodes.${p.id}.dates`,id,'上级日期范围不包含固定卡片安排');
    }
  }
}
export function cardsContext(data:WorkspaceData,nodeId:string) {
  const scope=new Set([...descendants(data,nodeId).map(n=>n.id),...trail(data,nodeId).map(n=>n.id)]);
  return Object.values(data.cards||{}).filter(c=>c.bindings.some(b=>scope.has(b.nodeId))||nodeId===data.rootId&&!c.bindings.length).map(({id,type,title,facts,reviewState,bookingStatus,bindings})=>({id,type,title,facts,reviewState,bookingStatus,bindings,readOnly:true}));
}
export function cardSummary(c:CardContent) {
  const moment=(m:CardMoment)=>[m.date,m.time,m.timezone].filter(Boolean).join(' ')||'时间待核对';
  if(c.type==='transport')return `${c.facts.departurePlace||'出发地待核对'} → ${c.facts.arrivalPlace||'到达地待核对'} · ${moment(c.facts.departure)} → ${moment(c.facts.arrival)}`;
  if(c.type==='lodging')return `${c.facts.name||'酒店待核对'} · ${c.facts.checkIn||'入住日待核对'} — ${c.facts.checkOut||'离店日待核对'}`;
  return `${c.facts.place||'地点待核对'} · ${moment(c.facts.start)}`;
}
