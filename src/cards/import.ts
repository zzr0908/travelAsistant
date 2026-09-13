import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { DB } from '../storage/database.js';
import type { Plans } from '../service/domain/plans.js';
import { ensure, AppError } from '../service/domain/validation.js';
import { cardContentSchema, cardSourceSchema, parseCard, type Card } from '../shared/cards.js';

export type CardExtractor=(text:string,schema:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>;
export const extractionSchema=z.object({cards:z.array(z.object({content:cardContentSchema,evidence:cardSourceSchema.shape.evidence}).strict()).min(1).max(20)}).strict();
const inputSchema=z.object({requestId:z.string().uuid(),workspaceId:z.string().uuid(),label:z.string().trim().min(1).max(250),text:z.string().max(50000).optional(),pdf:z.string().max(7*1024*1024).optional()}).strict().refine(v=>Number(v.text!==undefined)+Number(v.pdf!==undefined)===1,'请选择文字或 PDF');
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
export interface CardDraft {id:string;workspaceId:string;state:'running'|'ready'|'failed'|'saved';expires:number;cards:Card[];message?:string;duplicateIds?:string[]}
type Row={id:string;owner_id:string;workspace_id:string;request_hash:string;state:CardDraft['state'];body:string;expires:number};
export async function pdfText(bytes:Uint8Array) {
  ensure(bytes.length<=5*1024*1024,'PDF 超过 5MB，请缩小材料',413);
  ensure(Buffer.from(bytes.subarray(0,5)).toString()==='%PDF-','文件不是有效 PDF');
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const library=dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const task=getDocument({data:bytes,disableFontFace:true,useSystemFonts:false,useWorkerFetch:false,standardFontDataUrl:join(library,'standard_fonts/'),cMapUrl:join(library,'cmaps/'),cMapPacked:true});
  try {
    const doc=await task.promise;
    ensure(doc.numPages<=20,'PDF 超过 20 页，请只导入订单相关页面',413);
    let result='';
    for(let i=1;i<=doc.numPages;i++) {
      const page=await doc.getPage(i),content=await page.getTextContent();
      const text=content.items.map(item=>'str' in item?item.str+('hasEOL' in item&&item.hasEOL?'\n':' '):'').join('');
      // Do not silently omit scanned pages in a mixed document.
      ensure(text.trim().length>0,`第 ${i} 页没有可提取的文字，请改为粘贴文字或手工填写`);
      result+=text+'\n';
      ensure(result.length<=50000,'材料文字超过 5 万字，请缩小范围',413);
      page.cleanup();
    }
    return result.trim();
  } finally {await task.destroy();}
}
export class CardImports {
  private tasks=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private cleanup:ReturnType<typeof setInterval>;
  constructor(public db:DB,public plans:Plans,public extract?:CardExtractor) {
    db.prepare("UPDATE card_drafts SET state='failed',body=? WHERE state='running'").run(JSON.stringify({message:'服务已重启，导入未完成；请重新提交材料'}));
    this.expire();
    this.cleanup=setInterval(()=>this.expire(),60000);this.cleanup.unref();
  }
  private expire(){this.db.prepare('DELETE FROM card_drafts WHERE expires<=?').run(Date.now());}
  view(owner:string,id:string):CardDraft {
    const row=this.db.prepare('SELECT * FROM card_drafts WHERE id=? AND owner_id=?').get(id,owner) as Row|undefined;
    ensure(row&&row.expires>Date.now(),'草稿不存在或已过期',404);
    this.plans.access(row.workspace_id,owner,true);
    return {id:row.id,workspaceId:row.workspace_id,state:row.state,expires:row.expires,cards:[],...JSON.parse(row.body)};
  }
  list(owner:string,workspaceId:string) {
    this.plans.access(workspaceId,owner,true);this.expire();
    return (this.db.prepare("SELECT id FROM card_drafts WHERE owner_id=? AND workspace_id=? AND state!='saved' ORDER BY rowid DESC LIMIT 10").all(owner,workspaceId) as {id:string}[]).map(r=>this.view(owner,r.id));
  }
  update(owner:string,id:string,raw:unknown) {
    const current=this.view(owner,id);ensure(current.state==='ready','草稿尚不可编辑',409);
    const p=z.object({cards:z.array(z.unknown()).min(1).max(20)}).strict().parse(raw),cards=p.cards.map(parseCard);
    ensure(new Set(cards.map(c=>c.id)).size===cards.length,'卡片标识重复');
    for(const card of cards) {
      const old=current.cards.find(c=>c.id===card.id)||current.cards.find(c=>c.source.hash===card.source.hash&&c.type===card.type);ensure(old,'卡片不属于该草稿');
      ensure(card.source.hash===old.source.hash,'不能更改材料标识');
    }
    this.db.prepare('UPDATE card_drafts SET body=? WHERE id=?').run(JSON.stringify({...current,cards}),id);
    return this.view(owner,id);
  }
  start(owner:string,raw:unknown) {
    const input=inputSchema.parse(raw);this.plans.access(input.workspaceId,owner,true);this.expire();
    const requestHash=sha(JSON.stringify(input));
    const old=this.db.prepare('SELECT * FROM card_drafts WHERE owner_id=? AND request_id=?').get(owner,input.requestId) as Row|undefined;
    if(old){ensure(old.request_hash===requestHash,'同一请求标识不能用于不同材料',409);return this.view(owner,old.id);}
    ensure(this.extract,'模型尚未配置，请使用手工填写卡片',503);
    ensure(![...this.tasks.keys()].some(id=>(this.db.prepare('SELECT owner_id FROM card_drafts WHERE id=?').get(id) as {owner_id:string}|undefined)?.owner_id===owner),'已有材料正在导入，请稍候',409);
    ensure(this.tasks.size<2,'导入繁忙，请稍后重试',429);
    const id=randomUUID(),expires=Date.now()+86400000;
    this.db.prepare('INSERT INTO card_drafts VALUES(?,?,?,?,?,?,?,?)').run(id,owner,input.workspaceId,input.requestId,requestHash,'running','{}',expires);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
    const promise=Promise.resolve().then(async()=>{
      try {
        let text:string;
        if(input.pdf!==undefined) {
          ensure(/^[A-Za-z0-9+/]*={0,2}$/.test(input.pdf),'PDF 编码无效');
          text=await pdfText(new Uint8Array(Buffer.from(input.pdf,'base64')));
        } else text=input.text!.trim();
        ensure(text.length>0,'材料没有文字，请粘贴或手工填写');controller.signal.throwIfAborted();
        const output=extractionSchema.parse(await this.extract!(text,z.toJSONSchema(extractionSchema),controller.signal));
        controller.signal.throwIfAborted();this.plans.access(input.workspaceId,owner,true);
        const hash=sha(text),cards:Card[]=output.cards.map(({content,evidence})=>{
          ensure(Object.values(evidence).every(quote=>quote.trim().length>0&&text.includes(quote)),'提取的出处不在材料中，请手工核对填写');
          ensure(Object.keys(evidence).length>0,'提取结果缺少材料出处，请手工核对填写');
          return {...content,id:randomUUID(),source:{label:input.label,hash,evidence},reviewState:'pending',bindings:[]};
        });
        const existing=Object.values(this.plans.get(input.workspaceId).data.cards||{});
        const duplicateIds=existing.filter(c=>c.source.hash===hash||cards.some(n=>n.type===c.type&&n.title===c.title)).map(c=>c.id);
        this.db.prepare("UPDATE card_drafts SET state='ready',body=? WHERE id=?").run(JSON.stringify({cards,duplicateIds}),id);
      } catch(error) {
        this.db.prepare("UPDATE card_drafts SET state='failed',body=? WHERE id=?").run(JSON.stringify({message:controller.signal.aborted?'提取超时或服务停止，请缩小材料后重试':error instanceof z.ZodError?'提取字段格式不符合规范，请手工填写或检查材料':error instanceof AppError?error.message:'材料提取未完成，请确认 PDF 未加密且文字清晰，或改为手工填写。'}),id);
      } finally {clearTimeout(timer);this.tasks.delete(id);}
    });
    this.tasks.set(id,{controller,promise});
    return this.view(owner,id);
  }
  async close(){clearInterval(this.cleanup);for(const t of this.tasks.values())t.controller.abort();await Promise.allSettled([...this.tasks.values()].map(t=>t.promise));}
}
