import { randomUUID } from 'node:crypto';
import { digest } from '../../shared/hash.js';
import type { BrowserStorePort } from '../../shared/browser-port.js';
import { BrowserError, type BrowserRequest, type BrowserResult } from '../../shared/browser-model.js';

/** Only transient browser execution data. Authoritative results are committed by app. */
export class MemoryBrowserStore implements BrowserStorePort {
  private rows=new Map<string,any>();
  private artifacts=new Map<string,{owner:string;bytes:Buffer;mimeType:string;sha256:string}>();
  begin(owner:string,input:BrowserRequest) {
    const key=`${owner}:${input.requestId}`,old=this.rows.get(key),hash=digest(JSON.stringify(input));
    if(old){if(old.hash!==hash)throw new BrowserError('restricted','查询请求冲突');return {id:old.queryId,existing:true};}
    const row={queryId:randomUUID(),owner,hash,input,state:'queued',created:new Date().toISOString(),result:null};this.rows.set(key,row);return {id:row.queryId,existing:false};
  }
  private row(id:string){const row=[...this.rows.values()].find(r=>r.queryId===id);if(!row)throw new BrowserError('restricted','临时查询不存在');return row;}
  state(id:string,state:string){this.row(id).state=state;}
  finish(owner:string,result:BrowserResult,bytes?:Buffer){const row=this.row(result.queryId);if(row.owner!==owner)throw new BrowserError('restricted','查询归属无效');row.result=result;row.state=result.status;if(bytes&&result.artifact)this.artifacts.set(result.artifact.id,{owner,bytes,mimeType:result.artifact.mimeType,sha256:result.artifact.sha256});}
  get(owner:string,id:string){const row=this.row(id);if(row.owner!==owner)throw new BrowserError('restricted','查询归属无效');return row;}
  list(owner:string){return [...this.rows.values()].filter(r=>r.owner===owner);}
  artifact(owner:string,id:string){const row=this.artifacts.get(id);if(!row||row.owner!==owner)throw new BrowserError('restricted','截图归属无效');return row;}
  recover() {}
  forget(id:string){for(const [key,row] of this.rows)if(row.queryId===id){if(row.result?.artifact)this.artifacts.delete(row.result.artifact.id);this.rows.delete(key);}}
}
