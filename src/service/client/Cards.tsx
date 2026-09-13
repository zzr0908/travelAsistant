import { useEffect, useRef, useState } from 'react';
import { blankCard, cardLabels, cardSummary, fixedCardDates, parseCard, type Card } from '../../shared/cards';
import { dateLabel, type WorkspaceView } from '../../shared/model';
import type { CardDraft } from '../../cards/import';
import { Dialog, ErrorNotice } from './Forms';
import { api, post, uid, ApiError } from './api';

type Entry={card:Card;createUnder?:string};
type Save=(kind:string,payload:Record<string,unknown>,id:string,version:number)=>Promise<unknown>;
const fields:Record<Card['type'],[string,string,string?][]>= {
  transport:[['facts.mode','交通方式','mode'],['facts.serviceNumber','班次'],['facts.departurePlace','出发地'],['facts.arrivalPlace','到达地'],...['departure','arrival'].flatMap((k,i)=>[['facts.'+k+'.date',(i?'到达':'出发')+'日期','date'],['facts.'+k+'.time',(i?'到达':'出发')+'时间','time'],['facts.'+k+'.timezone',(i?'到达':'出发')+'时区']]) as [string,string,string?][]],
  lodging:[['facts.name','酒店'],['facts.address','地址'],['facts.checkIn','入住日','date'],['facts.checkOut','离店日','date'],['facts.checkInFrom','可办理入住起始时间','time'],['facts.checkInUntil','可办理入住截止时间','time'],['facts.timezone','时区']],
  reservation:[['facts.place','场所'],['facts.address','地址'],...['start','end'].flatMap((k,i)=>[['facts.'+k+'.date',(i?'结束':'预约')+'日期','date'],['facts.'+k+'.time',(i?'结束':'预约')+'时间','time'],['facts.'+k+'.timezone',(i?'结束':'预约')+'时区']]) as [string,string,string?][]],
};
function get(card:Card,path:string):string {return path.split('.').reduce<any>((v,k)=>v[k],card)??'';}
function change(card:Card,path:string,value:unknown) {const next=structuredClone(card),keys=path.split('.'),last=keys.pop()!;keys.reduce<any>((v,k)=>v[k],next)[last]=value;return next;}
function evidenceLabel(type:Card['type'],path:string) {const key=path.replace(/^content\./,'');return fields[type].find(([p])=>p===key)?.[1]||({title:'名称',bookingStatus:'预订状态'} as Record<string,string>)[key]||'材料摘录';}

export function KeyCards({workspace,nodeId,onSave}:{workspace:WorkspaceView;nodeId:string;onSave:Save}) {
  const [open,setOpen]=useState(false),[selected,setSelected]=useState<Card|null>(null);
  const cards=Object.values(workspace.data.cards||{}).filter(c=>nodeId===workspace.data.rootId||c.bindings.some(b=>b.nodeId===nodeId));
  const editable=workspace.role!=='reader';
  return <div className="key-cards">
    {editable&&<button className="text-button" onClick={()=>{setSelected(null);setOpen(true);}}>导入卡片</button>}
    {!!cards.length&&<details><summary>关键卡片 · {cards.length}</summary><div className="card-list">{cards.map(c=><button key={c.id} onClick={()=>{setSelected(c);setOpen(true);}}><span className="badge">{cardLabels[c.type]} · {c.reviewState==='reviewed'?'已核对':'待核对'}</span><strong>{c.title}</strong><span>{cardSummary(c)}</span></button>)}</div></details>}
    {open&&<CardDialog key={selected?.id||'import'} workspace={workspace} nodeId={nodeId} initial={selected} onClose={()=>setOpen(false)} onSave={onSave}/>}
  </div>;
}
export function CardDialog({workspace,nodeId,initial,onClose,onSave}:{workspace:WorkspaceView;nodeId:string;initial:Card|null;onClose:()=>void;onSave:Save}) {
  const [entries,setEntries]=useState<Entry[]>(initial?[{card:structuredClone(initial)}]:[]);
  const [text,setText]=useState(''),[file,setFile]=useState<File|null>(null),[draft,setDraft]=useState<CardDraft|null>(null),[drafts,setDrafts]=useState<CardDraft[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState(false),[saved,setSaved]=useState(false),[duplicate,setDuplicate]=useState(false),[draftNotice,setDraftNotice]=useState('');
  const [base,setBase]=useState(workspace),[conflict,setConflict]=useState<WorkspaceView|null>(null);
  const [pollEpoch,setPollEpoch]=useState(0);
  const request=useRef<{key:string;id:string}|null>(null),saving=useRef(false),mounted=useRef(true);
  const editable=workspace.role!=='reader';
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(initial||!editable)return;const c=new AbortController();void api<CardDraft[]>(`/api/card-drafts?workspaceId=${workspace.id}`,{signal:c.signal}).then(setDrafts).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[workspace.id,editable,initial]);
  useEffect(()=>{
    if(draft?.state!=='running')return;
    const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try {const next=await api<CardDraft>(`/api/card-drafts/${draft.id}`,{signal:c.signal});if(c.signal.aborted)return;setDraft(next);if(next.state==='ready'){setEntries(next.cards.map(card=>({card})));setBusy(false);}else if(next.state==='failed'){setError(next.message||'提取失败');setBusy(false);}else timer=setTimeout(poll,1000);}catch(e){if(!c.signal.aborted){setError((e as Error).message);setBusy(false);}}};
    timer=setTimeout(poll,500);return()=>{c.abort();clearTimeout(timer);};
  },[draft?.id,draft?.state,pollEpoch]);
  useEffect(()=>{
    if(!draft||draft.state!=='ready'||saved||preview||!entries.length)return;
    const timer=setTimeout(()=>{void api(`/api/card-drafts/${draft.id}`,{method:'PUT',body:JSON.stringify({cards:entries.map(e=>e.card)})}).then(()=>{if(mounted.current)setDraftNotice('草稿已保存，仅你可见，24 小时后过期');}).catch(()=>{if(mounted.current)setDraftNotice('草稿暂未保存，请保留当前页面');});},700);
    return()=>clearTimeout(timer);
  },[entries,draft?.id,draft?.state,saved,preview]);
  function manual(type:Card['type']) {setDraft(null);setEntries([{card:{...blankCard(type),id:uid(),source:{label:'手工填写',hash:null,evidence:{}},reviewState:'pending',bindings:[]}}]);setError('');}
  async function start() {
    if(saving.current)return;saving.current=true;setBusy(true);setError('');
    try {
      let pdf:string|undefined;
      if(file){if(file.size>5*1024*1024)throw new Error('PDF 超过 5MB，请缩小材料');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));pdf=btoa(binary);}
      const body={workspaceId:workspace.id,label:file?.name||'粘贴文字',...(pdf!==undefined?{pdf}:{text})},key=JSON.stringify(body);
      if(request.current?.key!==key)request.current={key,id:uid()};
      const next=await post<CardDraft>('/api/card-drafts',{...body,requestId:request.current!.id});
      setDraft(next);
      setPollEpoch(v=>v+1);
      if(next.state==='saved'){setSaved(true);setBusy(false);}
      if(next.state==='ready'){setEntries(next.cards.map(card=>({card})));setBusy(false);}
      if(next.state==='failed'){setError(next.message||'提取失败');setBusy(false);request.current=null;}
    }catch(e){setError((e as Error).message);setBusy(false);}finally{saving.current=false;}
  }
  const update=(index:number,entry:Entry)=>{setEntries(prev=>prev.map((e,i)=>i===index?entry:e));setPreview(false);};
  function review() {
    try {for(const {card,createUnder} of entries){parseCard(card);if(createUnder||card.bindings.some(b=>b.mode==='fixed_event'))fixedCardDates(card);}setError('');setPreview(true);}catch(e){setError((e as Error).message);}
  }
  async function save() {
    if(saving.current||saved)return;saving.current=true;setBusy(true);setError('');
    try {await onSave('cards',{entries,...(draft?{draftId:draft.id}:{}),duplicateConfirmed:duplicate},workspace.id,base.version);setSaved(true);}
    catch(e){setError((e as Error).message);if(e instanceof ApiError&&e.status===409){try{setConflict(await api<WorkspaceView>(`/api/workspaces/${workspace.id}`));}catch{}}}
    finally{saving.current=false;setBusy(false);}
  }
  return <Dialog title={initial?'关键卡片':'导入关键卡片'} onClose={onClose} busy={busy}>
    <div className="dialog-body card-dialog">
      <ErrorNotice error={error}/>
      {saved?<><p role="status">卡片已保存，关联安排已同步。可通过计划历史撤销本次保存。</p><button onClick={onClose}>完成</button></>:<>
      {!entries.length&&<>
        <p>支持交通、住宿和定时预约。文字将交给当前已配置的模型提取，核对后才保存到旅行。</p>
        <label>粘贴材料<textarea value={text} maxLength={50000} disabled={busy||!!file} onChange={e=>setText(e.target.value)} rows={6}/></label>
        <label>或选择含文字层的 PDF（最多 5MB / 20 页）<input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={e=>setFile(e.target.files?.[0]||null)}/></label>
        <p className="muted">不保存原始 PDF。扫描件请改为文字或手工填写。提取时不推断缺失信息。</p>
        <button className="primary" disabled={busy||(!text.trim()&&!file)} onClick={()=>void start()}>{busy?'正在提取…':'提取卡片'}</button>
        {!busy&&draft?.state==='running'&&<button onClick={()=>{setError('');setBusy(true);setPollEpoch(v=>v+1);}}>重新读取导入结果</button>}
        {!busy&&<div className="button-row">{(['transport','lodging','reservation'] as const).map(type=><button key={type} onClick={()=>manual(type)}>手工填写{cardLabels[type]}</button>)}</div>}
        {!!drafts.length&&<details><summary>恢复导入草稿</summary>{drafts.map(d=><button key={d.id} disabled={busy||d.state==='failed'} onClick={()=>{setDraft(d);setEntries(d.cards.map(card=>({card})));setBusy(d.state==='running');}}>{d.cards[0]?.title||d.message||'正在提取'} · {new Date(d.expires).toLocaleString()} 到期</button>)}</details>}
      </>}
      {!!entries.length&&<>
        <p className="muted">下列字段与出处会按旅行权限共享。空白表示未知；“已核对”不表示系统验证了订单。请删除摘录中的无关个人信息。</p>
        {draftNotice&&<p role="status">{draftNotice}</p>}
        {entries.map((entry,index)=>{
          const c=entry.card,locked=!editable||preview;
          return <section className="card-editor" key={c.id}>
            <h3>{cardLabels[c.type]} · {index+1}</h3>
            <fieldset disabled={locked||busy}>
              <label>名称<input value={c.title} maxLength={160} onChange={e=>update(index,{...entry,card:change(c,'title',e.target.value)})}/></label>
              {draft&&!!Object.values(base.data.cards||{}).filter(old=>old.type===c.type).length&&<label>更新已有卡片（可选）<select value={base.data.cards?.[c.id]?c.id:''} onChange={e=>{const old=base.data.cards?.[e.target.value];update(index,{card:{...c,id:old?.id||uid(),bindings:old?structuredClone(old.bindings):[]}});}}><option value="">保存为新卡片</option>{Object.values(base.data.cards||{}).filter(old=>old.type===c.type).map(old=><option key={old.id} value={old.id}>{old.title} · {cardSummary(old)}</option>)}</select></label>}
              <div className="card-fields">{fields[c.type].map(([path,label,type])=><label key={path}>{label}{type==='mode'?<select value={get(c,path)} onChange={e=>update(index,{...entry,card:change(c,path,e.target.value)})}><option value="flight">飞机</option><option value="train">火车</option><option value="other">其他交通</option></select>:<input type={type||'text'} value={get(c,path)} placeholder={path.endsWith('timezone')?'如 Asia/Shanghai；未知留空':'未知可留空'} onChange={e=>update(index,{...entry,card:change(c,path,e.target.value||null)})}/>}</label>)}</div>
              <label>预订状态<select value={c.bookingStatus} onChange={e=>update(index,{...entry,card:change(c,'bookingStatus',e.target.value)})}><option value="unknown">未知</option><option value="confirmed">材料或本人确认已预订</option><option value="cancelled">已取消</option></select></label>
              <label className="check-row"><input type="checkbox" checked={c.reviewState==='reviewed'} onChange={e=>update(index,{...entry,card:{...c,reviewState:e.target.checked?'reviewed':'pending'}})}/>我已核对上述字段；空白信息仍未知</label>
              <details><summary>材料出处 · {c.source.label}</summary>{Object.entries(c.source.evidence).map(([path,quote])=><label key={path}>{evidenceLabel(c.type,path)}<textarea rows={2} maxLength={500} value={quote} onChange={e=>update(index,{...entry,card:{...c,source:{...c.source,evidence:{...c.source.evidence,[path]:e.target.value}}}})}/></label>)}{!Object.keys(c.source.evidence).length&&<p>手工填写，无材料摘录。</p>}</details>
              <label>保存方式<select value={entry.createUnder?'create':c.bindings.length?'link':'only'} onChange={e=>update(index,{card:{...c,bindings:e.target.value==='link'?[{nodeId,mode:'reference'}]:[]},...(e.target.value==='create'?{createUnder:nodeId}:{})})}><option value="only">仅保存卡片</option><option value="link">关联现有安排</option>{c.type!=='lodging'&&<option value="create">加入计划，创建固定安排</option>}</select></label>
              {entry.createUnder&&<label>加入哪个计划<select value={entry.createUnder} onChange={e=>update(index,{...entry,createUnder:e.target.value})}>{Object.values(base.data.nodes).map(n=><option key={n.id} value={n.id}>{n.title}</option>)}</select></label>}
              {c.bindings.map((b,bi)=><div className="card-binding" key={bi}><label>关联计划<select value={b.nodeId} onChange={e=>update(index,{...entry,card:{...c,bindings:c.bindings.map((v,i)=>i===bi?{...v,nodeId:e.target.value}:v)}})}>{Object.values(base.data.nodes).map(n=><option key={n.id} value={n.id}>{n.title}</option>)}</select></label><label>关联方式<select value={b.mode} onChange={e=>update(index,{...entry,card:{...c,bindings:c.bindings.map((v,i)=>i===bi?{...v,mode:e.target.value as 'reference'|'fixed_event'}:v)}})}><option value="reference">参考信息，不改变安排时间</option>{c.type!=='lodging'&&<option value="fixed_event">固定安排，同步卡片时间</option>}</select></label><button type="button" onClick={()=>update(index,{...entry,card:{...c,bindings:c.bindings.filter((_,i)=>i!==bi)}})}>解除此关联</button></div>)}
              {!!c.bindings.length&&<button type="button" onClick={()=>update(index,{...entry,card:{...c,bindings:[...c.bindings,{nodeId,mode:'reference'}]}})}>再关联一个计划</button>}
            </fieldset>
            {preview&&<div className="card-save-preview"><strong>{cardSummary(c)}</strong><p>{entry.createUnder?`将新增固定安排到：${base.data.nodes[entry.createUnder]?.title}`:c.bindings.length?'将保存以下关联':'仅保存卡片，不新增安排'}</p>{c.bindings.map(b=><p key={b.nodeId}>{base.data.nodes[b.nodeId]?.title}：{b.mode==='reference'?'仅参考，时间不变':`${dateLabel(base.data.nodes[b.nodeId].dates)} → ${dateLabel(fixedCardDates(c))} · ${fixedCardDates(c).timezone}`}</p>)}{entry.createUnder&&<p>计划时区：{fixedCardDates(c).timezone} · {dateLabel(fixedCardDates(c))}</p>}{initial?.bindings.some(old=>old.mode==='fixed_event'&&!c.bindings.some(b=>b.nodeId===old.nodeId&&b.mode==='fixed_event'))&&<p>解除卡片约束后，原安排仍保留固定标记与时间；可在计划编辑中调整。</p>}</div>}
          </section>;
        })}
        {editable&&<>
          {!!draft?.duplicateIds?.length&&<p role="status">发现已导入或同名卡片，请先核对，避免重复加入计划。</p>}
          <label className="check-row"><input type="checkbox" checked={duplicate} disabled={busy} onChange={e=>setDuplicate(e.target.checked)}/>如材料已导入，我确认本次仍需保存（不会自动覆盖已有卡片）</label>
          {conflict&&<div role="alert"><p>当前计划已更新到版本 {conflict.version}。输入仍保留，请核对最新计划后重新预览。</p><button onClick={()=>{setBase(conflict);setConflict(null);setPreview(false);setError('');}}>使用最新计划重新预览</button></div>}
          <div className="button-row">{preview?<><button disabled={busy} onClick={()=>setPreview(false)}>返回修改</button><button className="primary" disabled={busy||!!conflict} onClick={()=>void save()}>确认保存卡片与关联</button></>:<button className="primary" disabled={busy} onClick={review}>查看保存内容</button>}</div>
        </>}
      </>}
      </>}
    </div>
  </Dialog>;
}
