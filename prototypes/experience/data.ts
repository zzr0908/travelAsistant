import geometry from './geometry.json';
export type Scope = 'trip' | 'day' | 'walk' | 'bridge' | 'street' | 'square' | 'uffizi' | 'signoria' | 'cafe';
export type Tab = 'plan' | 'content' | 'map';
export interface Place { id: Exclude<Scope,'trip'|'day'|'walk'>; name: string; localName: string; kind: string; coordinates: [number,number]; description: string; source: string; photo?: string; article: string; }
const point = (name:string):[number,number] => geometry.places.find(p=>p.name===name)!.geometry.coordinates as [number,number];
export const places:Place[] = [
  { id:'bridge', name:'老桥', localName:'Ponte Vecchio',kind:'桥梁',coordinates:point('Ponte Vecchio'),description:'从河上的桥开始这段散步，留一点时间看看两岸。',source:'https://www.visittuscany.com/en/attractions/ponte-vecchio/',article:'walk'},
  { id:'street',name:'旧城街巷',localName:'Borgo de’ Greci',kind:'街道',coordinates:geometry.streetPoint as [number,number],description:'顺着旧城街巷走向广场，沿街慢慢看，不必把每一处都排成停留。',source:'https://www.openstreetmap.org/',article:'walk'},
  { id:'square',name:'圣十字广场',localName:'Piazza Santa Croce',kind:'广场',coordinates:point('Piazza Santa Croce'),description:'把这里作为上午散步的终点，在广场留一段自由停留时间。',source:'https://www.feelflorence.it/',article:'walk'},
  { id:'uffizi',name:'乌菲齐美术馆',localName:'Galleria degli Uffizi',kind:'美术馆',coordinates:point('Galleria degli Uffizi'),description:'想多看一些建筑与绘画，可以把乌菲齐留作沿途的另一个选择。',source:'https://www.uffizi.it/en/the-uffizi',photo:'/assets/uffizi-1.webp',article:'uffizi'},
  { id:'signoria',name:'领主广场',localName:'Piazza della Signoria',kind:'广场',coordinates:point('Piazza della Signoria'),description:'在旧城段多留一会儿，从广场观察周围建筑，再继续往圣十字方向走。',source:'https://www.feelflorence.it/',article:'walk'},
  { id:'cafe',name:'Alimentari Uffizi',localName:'Alimentari Uffizi',kind:'餐饮',coordinates:point('Alimentari Uffizi'),description:'如果想在途中休息，可先查看这处餐饮地点；营业情况和菜单仍需核实。',source:'https://www.openstreetmap.org/node/2361650878',article:'pause'},
];
export interface Stop { id: Exclude<Scope,'trip'|'day'|'walk'>; time:string; title:string; summary:string; }
export const initialStops:Stop[] = [
  {id:'bridge',time:'10:00',title:'老桥与河景',summary:'从阿尔诺河开始，看看桥与两岸。'},
  {id:'street',time:'10:20',title:'穿过旧城街巷',summary:'沿 Borgo de’ Greci 慢慢走，留意沿途看点。'},
  {id:'square',time:'11:00',title:'圣十字广场',summary:'留一段自由时间，结束上午的散步。'},
];
export const articles = [
  {id:'uffizi',title:'乌菲齐：从建筑到绘画',summary:'先看外部建筑，再决定是否把馆内参观加入安排。',category:'景点介绍',photo:'/assets/uffizi-1.webp',place:'uffizi' as Scope, plans:['uffizi'] as Scope[]},
  {id:'walk',title:'从老桥走到圣十字',summary:'把桥、旧城街巷和广场连成一段轻松的上午散步。',category:'散步攻略',place:'bridge' as Scope, plans:['walk','bridge','street','square'] as Scope[]},
  {id:'entry',title:'预约与入馆',summary:'确定日期后，逐项完成参观前的核对。',category:'具体指引',place:'uffizi' as Scope, plans:['uffizi'] as Scope[]},
  {id:'pause',title:'给途中留一次休息',summary:'先留出时间，再根据当天情况决定在哪里停。',category:'途中笔记',place:'cafe' as Scope, plans:['cafe'] as Scope[]},
];
export const gallery = [
  {src:'/assets/uffizi-1.webp',alt:'乌菲齐美术馆建筑立面',caption:'乌菲齐美术馆建筑',source:'https://www.uffizi.it/en/the-uffizi'},
  {src:'/assets/uffizi-2.webp',alt:'乌菲齐官网绘画专题中的肖像局部',caption:'绘画专题 · 官网配图',source:'https://www.uffizi.it/en/the-uffizi/painting'},
];
export { geometry };

// A shared hierarchy supplies sidebar, breadcrumb and page titles.
export const planNames = { trip: '意大利旅行', day: '第一天 · 佛罗伦萨', walk: '从老桥到圣十字' };
export function scopeTitle(scope:Scope, stops:Stop[]) {
  if (scope === 'trip' || scope === 'day' || scope === 'walk') return planNames[scope];
  return stops.find(s => s.id === scope)?.title || places.find(p => p.id === scope)?.name || '当前安排';
}
export function scopePath(scope:Scope):Scope[] {
  if (scope === 'trip') return ['trip'];
  if (scope === 'day') return ['trip','day'];
  if (scope === 'walk') return ['trip','day','walk'];
  return ['trip','day','walk',scope];
}
export function notesForScope(scope:Scope, stops:Stop[]) {
  const linkedScopes:Scope[] = ['trip','day','walk'].includes(scope) ? ['walk',...stops.map(s => s.id)] : [scope];
  return articles.filter(a => a.plans.some(plan => linkedScopes.includes(plan)));
}
