import { harnessValidator } from '../storage/agent-backup.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../storage/database.js';
import { canonical, digest } from '../shared/hash.js';
import { AppError, ensure } from '../service/domain/validation.js';
import { EXECUTION_PROTOCOL, type ExecutionKind, type ExecutionTask } from '../shared/execution.js';
import vocabulary from '../shared/harness-event-types.json' with { type: 'json' };

type Worker = { id: string; capabilities: string[]; seen: number; version: string };
type Job = {id:string; kind:ExecutionKind; payload:string; state:string; worker_id:string|null; lease:string|null; lease_until:number|null; deadline:number; affinity:string|null; result:string|null; error:string|null};
type Pending = {
  resolve(value:any):void; reject(error:Error):void; controller:AbortController;
  call?(method:string, value:any):unknown | Promise<unknown>;
  finish?(value:any):void;
  cleanup():void;
};
const identity = z.object({instanceId:z.string().uuid(),lease:z.string().uuid()});
const registration = z.object({instanceId:z.string().uuid(),protocol:z.literal(EXECUTION_PROTOCOL),version:z.string().min(1).max(100),capabilities:z.array(z.enum(['research','browser','image','release'])).max(4)}).strict();
export class ExecutionBroker {
  readonly app: FastifyInstance;
  private workers = new Map<string,Worker>();
  private pending = new Map<string,Pending>();
  private inFlight = new Map<string,Promise<unknown>>();
  private timer:ReturnType<typeof setInterval>;
  private closing = false;
  constructor(readonly db:DB, private token:string, readonly leaseMs=15000) {
    ensure(token.length>=32, '服务间凭据至少需要 32 个字符');
    // Pending callbacks belonged to the previous app incarnation. Never replay them.
    db.prepare("UPDATE execution_jobs SET state='interrupted',error='app_restarted' WHERE state IN ('queued','running')").run();
    this.app=Fastify({bodyLimit:2*1024*1024,logger:false});
    this.app.addHook('onRequest', async req => {
      const supplied=Buffer.from(req.headers.authorization || '');
      const expected=Buffer.from(`Bearer ${token}`);
      ensure(supplied.length===expected.length && timingSafeEqual(supplied,expected),'内部服务鉴权失败',401);
      ensure(!req.headers.cookie && !req.headers.origin,'内部接口不接受浏览器会话',403);
    });
    this.app.setErrorHandler((error,_req,reply)=> {
      const status=error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 503;
      reply.code(status).send({message:error instanceof AppError ? error.message : status===400 ? '内部协议格式不符' : '内部操作未完成'});
    });
    this.app.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:16*1024*1024},(_req,body,done)=>done(null,body));
    this.routes();
    this.timer=setInterval(()=>this.sweep(),Math.min(1000,leaseMs/3));this.timer.unref();
  }
  workerForJob(id:string) {return this.job(id).worker_id;}
  workerAvailable(id:string) {return (this.workers.get(id)?.seen || 0)>Date.now()-this.leaseMs;}
  capability(kind:ExecutionKind) {
    return !this.closing && [...this.workers.values()].some(w=>w.seen>Date.now()-this.leaseMs && w.capabilities.includes(kind));
  }
  status() { return {protocol:EXECUTION_PROTOCOL,available:this.capability('research'),message:this.capability('research')?'Agent 服务已连接':'Agent 服务未连接或模型未配置，可继续手动规划。',workers:[...this.workers.values()].filter(w=>w.seen>Date.now()-this.leaseMs).map(w=>({version:w.version,capabilities:w.capabilities}))}; }
  submit(kind:ExecutionKind,payload:unknown,options:{signal?:AbortSignal;timeoutMs?:number;affinity?:string;call?:Pending['call'];finish?:Pending['finish'];blobs?:Record<string,Buffer>}={}) {
    ensure(!this.closing && this.capability(kind),'Agent 执行能力暂时不可用',503);
    options.signal?.throwIfAborted();
    ensure(!options.affinity || this.workerAvailable(options.affinity),'原执行实例已离线，请重新发起研究',503);
    const id=randomUUID(), now=Date.now(), controller=new AbortController();
    this.db.transaction(()=>{
      this.db.prepare("INSERT INTO execution_jobs(id,kind,payload,state,affinity,deadline,created) VALUES(?,?,?,'queued',?,?,?)").run(id,kind,JSON.stringify(payload),options.affinity || null,now+(options.timeoutMs || 180000),now);
      for(const [name,bytes] of Object.entries(options.blobs || {}))this.saveBlob(id,name,bytes);
    })();
    const promise=new Promise<any>((resolve,reject)=>{
      const abort=()=>this.fail(id,'cancelled','执行已取消');
      this.pending.set(id,{resolve,reject,controller,call:options.call,finish:options.finish,cleanup:()=>options.signal?.removeEventListener('abort',abort)});
      options.signal?.addEventListener('abort',abort,{once:true});
      if(options.signal?.aborted)abort();
    });
    return {id,promise};
  }
  private job(id:string):Job { const row=this.db.prepare('SELECT * FROM execution_jobs WHERE id=?').get(id) as Job|undefined;ensure(row,'执行任务不存在',404);return row; }
  private authorize(id:string,raw:unknown,live=true) {
    const who=identity.parse(raw),row=this.job(id);
    ensure(row.worker_id===who.instanceId && row.lease===who.lease,'执行凭据已失效',409);
    if(live)ensure(row.state==='running' && row.lease_until!>Date.now() && row.deadline>Date.now() && this.pending.has(id),'执行已中断或取消',409);
    return row;
  }
  private fail(id:string,state:string,message:string) {
    const p=this.pending.get(id);if(!p)return;
    this.db.prepare("UPDATE execution_jobs SET state=?,error=? WHERE id=? AND state IN ('queued','running')").run(state,message,id);
    this.pending.delete(id);p.cleanup();p.controller.abort(new Error(message));p.reject(new AppError(503,message));
  }
  private sweep() {
    const now=Date.now();
    for(const row of this.db.prepare("SELECT * FROM execution_jobs WHERE state IN ('queued','running')").all() as Job[]) {
      if(row.deadline<=now || (row.state==='running' && row.lease_until!<=now))this.fail(row.id,'interrupted','Agent 执行中断，已保存资料保留；不会自动重复模型请求。');
    }
  }
  private saveBlob(id:string,name:string,bytes:Buffer) {
    ensure(/^[a-zA-Z0-9_-]{1,64}$/.test(name) && bytes.length<=16*1024*1024,'执行附件无效',400);
    const old=this.db.prepare('SELECT sha256 FROM execution_blobs WHERE job_id=? AND name=?').get(id,name) as {sha256:string}|undefined;
    if(old){ensure(old.sha256===digest(bytes),'同名执行附件内容冲突',409);return;}
    ensure((this.db.prepare('SELECT count(*) n FROM execution_blobs WHERE job_id=?').get(id) as {n:number}).n<6,'执行附件过多',413);
    this.db.prepare('INSERT INTO execution_blobs VALUES(?,?,?,?)').run(id,name,bytes,digest(bytes));
  }
  blob(id:string,name:string) {const row=this.db.prepare('SELECT bytes FROM execution_blobs WHERE job_id=? AND name=?').get(id,name) as {bytes:Buffer}|undefined;ensure(row,'执行附件未提交',409);return row.bytes;}
  consumeBlobs(id:string,names:string[]) {const bytes=names.map(name=>this.blob(id,name));this.db.prepare('DELETE FROM execution_blobs WHERE job_id=?').run(id);return bytes;}
  private async operation(id:string,raw:any):Promise<any> {
    const p=z.object({instanceId:z.string().uuid(),lease:z.string().uuid(),operationId:z.string().uuid(),method:z.enum(['tool','beforeModel','usage','request','text','session.create','session.read','session.append']),value:z.unknown()}).strict().parse(raw);
    this.authorize(id,p,false);
    const hash=digest(canonical({method:p.method,value:p.value}));
    const previous=this.db.prepare('SELECT hash,result FROM execution_receipts WHERE job_id=? AND operation_id=?').get(id,p.operationId) as {hash:string;result:string}|undefined;
    if(previous){ensure(previous.hash===hash,'内部请求标识冲突',409);return JSON.parse(previous.result);}
    this.authorize(id,p);
    const key=`${id}:${p.operationId}`;
    const running=this.inFlight.get(key);if(running){await running;return this.operation(id,raw);}
    const action=(async()=>{
      const job=this.job(id),pending=this.pending.get(id)!;
      let value:unknown;
      if(p.method.startsWith('session.')) value=this.session(job,p.method,p.value);
      else {ensure(pending.call,'该任务不接受工具回调',403);value=await pending.call(p.method,p.value);}
      // Tool callbacks enforce scope and cancellation too. An expired worker cannot commit receipts.
      this.authorize(id,p);
      const result={value:value??null};
      this.db.prepare('INSERT INTO execution_receipts VALUES(?,?,?,?)').run(id,p.operationId,hash,JSON.stringify(result));
      return result;
    })();
    this.inFlight.set(key,action);
    try{return await action;}finally{this.inFlight.delete(key);}
  }
  private session(job:Job,method:string,value:any) {
    ensure(job.kind==='research' || (job.kind==='release' && JSON.parse(job.payload).researchId),'该任务不支持模型日志',403);
    const runId=JSON.parse(job.payload).id || JSON.parse(job.payload).researchId;
    ensure(this.db.prepare('SELECT id FROM agent_runs WHERE id=?').get(runId),'研究任务不存在',404);
    if(method==='session.create') {
      const header=value?.header;
      ensure(header?.id===runId && header.version===vocabulary.sessionFormat,'会话格式或任务归属不符',400);
      const inherited=value.inheritedCount || 0;ensure(Number.isSafeInteger(inherited)&&inherited>=0,'继承序号无效');
      const old=this.db.prepare('SELECT header,inherited_count FROM harness_sessions WHERE id=?').get(runId) as any;
      if(old)ensure(canonical(JSON.parse(old.header))===canonical(header)&&old.inherited_count===inherited,'会话已存在',409);
      else this.db.prepare('INSERT INTO harness_sessions VALUES(?,?,?)').run(runId,JSON.stringify(header),inherited);
    }
    if(method==='session.append') {
      const events=z.array(z.object({seq:z.number().int().min(0),type:z.string(),time:z.number().int().min(0),data:z.record(z.string(),z.unknown()),ignorable:z.boolean().optional()}).passthrough()).max(100).parse(value?.events);
      this.db.transaction(()=>{
        const session=this.db.prepare('SELECT header FROM harness_sessions WHERE id=?').get(runId) as {header:string}|undefined;
        ensure(session,'会话尚未创建',409);harnessValidator().validateStoredEvents(JSON.parse(session.header),events);
        for(const event of events){
          ensure(vocabulary.events.includes(event.type)||event.ignorable===true,'未知必需日志类型');
          const body=JSON.stringify(event),old=this.db.prepare('SELECT body FROM harness_events WHERE session_id=? AND seq=?').get(runId,event.seq) as {body:string}|undefined;
          if(old){ensure(canonical(JSON.parse(old.body))===canonical(event),'日志序号内容冲突',409);continue;}
          const count=(this.db.prepare('SELECT count(*) n FROM harness_events WHERE session_id=?').get(runId) as {n:number}).n;
          ensure(event.seq===count,'日志序号不连续',409);
          this.db.prepare('INSERT INTO harness_events VALUES(?,?,?,?)').run(runId,event.seq,body,digest(body));
        }
      })();
    }
    if(method==='session.append')return {ok:true};
    const row=this.db.prepare('SELECT * FROM harness_sessions WHERE id=?').get(runId) as any;
    return row?{header:JSON.parse(row.header),inheritedCount:row.inherited_count,events:(this.db.prepare('SELECT body FROM harness_events WHERE session_id=? ORDER BY seq').all(runId) as {body:string}[]).map(r=>JSON.parse(r.body))}:null;
  }
  private routes() {
    const a=this.app;
    a.get('/internal/agent/v1/status',async()=>this.status());
    a.post('/internal/agent/v1/register',async req=>{const p=registration.parse(req.body);this.workers.set(p.instanceId,{id:p.instanceId,capabilities:p.capabilities,seen:Date.now(),version:p.version});return {protocol:EXECUTION_PROTOCOL,leaseMs:this.leaseMs};});
    a.post('/internal/agent/v1/claim',async req=>{
      const p=z.object({instanceId:z.string().uuid(),kinds:z.array(z.enum(['research','browser','image','release'])).min(1)}).strict().parse(req.body);
      const w=this.workers.get(p.instanceId);ensure(w,'请先注册执行实例',409);w.seen=Date.now();
      return this.db.transaction(()=>{
        const rows=this.db.prepare("SELECT * FROM execution_jobs WHERE state='queued' AND deadline>? ORDER BY created").all(Date.now()) as Job[];
        const job=rows.find(j=>this.pending.has(j.id)&&p.kinds.includes(j.kind)&&w.capabilities.includes(j.kind)&&(!j.affinity||j.affinity===w.id));
        if(!job)return {task:null};
        const lease=randomUUID();this.db.prepare("UPDATE execution_jobs SET state='running',worker_id=?,lease=?,lease_until=? WHERE id=? AND state='queued'").run(w.id,lease,Date.now()+this.leaseMs,job.id);
        return {task:{id:job.id,kind:job.kind,payload:JSON.parse(job.payload),lease,deadline:job.deadline} satisfies ExecutionTask};
      })();
    });
    a.post('/internal/agent/v1/jobs/:id/renew',async req=>{const id=(req.params as any).id,row=this.authorize(id,req.body);this.db.prepare('UPDATE execution_jobs SET lease_until=? WHERE id=?').run(Math.min(Date.now()+this.leaseMs,row.deadline),id);const w=this.workers.get(row.worker_id!);if(w)w.seen=Date.now();return {ok:true};});
    a.post('/internal/agent/v1/jobs/:id/call',async req=>this.operation((req.params as any).id,req.body));
    a.put('/internal/agent/v1/jobs/:id/blobs/:name',{bodyLimit:16*1024*1024},async req=>{const {id,name}=req.params as any;this.authorize(id,{instanceId:req.headers['x-worker-id'],lease:req.headers['x-worker-lease']});ensure(Buffer.isBuffer(req.body),'附件需要二进制',400);this.saveBlob(id,name,req.body);return {ok:true,sha256:digest(req.body)};});
    a.get('/internal/agent/v1/jobs/:id/blobs/:name',async(req,reply)=>{const {id,name}=req.params as any;this.authorize(id,{instanceId:req.headers['x-worker-id'],lease:req.headers['x-worker-lease']});return reply.type('application/octet-stream').send(this.blob(id,name));});
    a.post('/internal/agent/v1/jobs/:id/complete',async req=>{
      const id=(req.params as any).id,p=z.object({instanceId:z.string().uuid(),lease:z.string().uuid(),result:z.unknown().optional(),error:z.string().max(2000).optional()}).strict().parse(req.body);
      const row=this.authorize(id,p,false),result=JSON.stringify(p.result??null);
      if(['completed','failed'].includes(row.state)){ensure(row.result===result&&row.error===(p.error||null),'完成回执冲突',409);return {ok:true};}
      this.authorize(id,p);const pending=this.pending.get(id)!;
      this.db.transaction(()=>{
        if(!p.error)pending.finish?.(p.result);
        this.db.prepare('UPDATE execution_jobs SET state=?,result=?,error=? WHERE id=?').run(p.error?'failed':'completed',result,p.error||null,id);
      })();
      this.pending.delete(id);pending.cleanup();
      if(p.error)pending.reject(new AppError(503,p.error));else pending.resolve({result:p.result,jobId:id,workerId:row.worker_id});
      return {ok:true};
    });
  }
  async listen(host:string,port:number) {await this.app.listen({host,port});}
  async close() {
    if(this.closing)return;this.closing=true;clearInterval(this.timer);
    for(const id of [...this.pending.keys()])this.fail(id,'interrupted','功能服务已停止，研究中断');
    await this.app.close();
  }
}
