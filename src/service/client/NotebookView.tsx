import {useNoteNavigation} from './note-navigation';
import {noteGroups,noteExcerpt,noteReadingBody} from '../../shared/note-groups';
import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Pencil, ArrowLeft, Trash2 } from 'lucide-react';
import { notesForPlan, legacyNoteCount, type Note, type NoteFields } from '../../shared/notes';
import { trail, type WorkspaceView } from '../../shared/model';
import { ErrorNotice } from './Forms';
import { NotePlaces } from './NotePlaces';
import { RichContent } from './RichContent';
import { MediaGallery } from './MediaGallery';
import { api, ApiError } from './api';
import type { MediaAsset } from '../../shared/agent';

interface Props {
  workspace: WorkspaceView;
  nodeId: string;
  userId: string;
  children?: ReactNode;
  onRefresh(workspace: WorkspaceView): void;
  onSave(kind: string, payload: Record<string, unknown>, version: number): Promise<unknown>;
}
export function NotebookView({ workspace: w, nodeId, userId, onSave, onRefresh, children }: Props) {
  const [createdFrom,setCreatedFrom]=useState<string[]>();
  const [search,setSearch]=useState('');
  const [images, setImages] = useState<MediaAsset[]>([]), [options, setOptions] = useState<MediaAsset[]>([]);
  const {selected,readingRoot,rows,selectNote}=useNoteNavigation();
  const [draft, setDraft] = useState<{ id?: string; fields: NoteFields; version: number }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const [mediaError, setMediaError] = useState(''), [optionsError, setOptionsError] = useState('');
  const [mediaAttempt, setMediaAttempt] = useState(0), [optionsAttempt, setOptionsAttempt] = useState(0);
  const [optionsLoading, setOptionsLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setMediaError('');
    const timer = setTimeout(() => { setMediaError('读取图片超时，笔记文字仍可阅读。'); controller.abort(); }, 10000);
    api<{media: MediaAsset[]}>(`/api/workspaces/${w.id}/media`, {signal: controller.signal}).then(r => {if (!controller.signal.aborted) setImages(r.media);}).catch(e => {if (!controller.signal.aborted) setMediaError(e.message);}).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [w.id, w.version, mediaAttempt]);
  useEffect(() => {
    if (!draft) return;
    const controller = new AbortController();
    setOptionsError(''); setOptionsLoading(true);
    const timer = setTimeout(() => { setOptionsError('读取图片选项超时。'); setOptionsLoading(false); controller.abort(); }, 10000);
    api<{media: MediaAsset[]}>(`/api/workspaces/${w.id}/media-options`, {signal:controller.signal}).then(r => {if (!controller.signal.aborted) setOptions(r.media);}).catch(e => {if (!controller.signal.aborted) setOptionsError(e.message);}).finally(() => {clearTimeout(timer); if (!controller.signal.aborted) setOptionsLoading(false);});
    return () => { clearTimeout(timer); controller.abort(); };
  }, [w.id, !!draft, optionsAttempt]);
  const notes = notesForPlan(w.data, nodeId), note = selected ? notes.find(n => n.id === selected) : notes[0];
  const visibleNotes=noteGroups(w.data,nodeId,search).flatMap(group=>group.notes);
  const choose=(id:string)=>{if(busy)return;if(draft && !window.confirm("放弃未保存的修改？"))return;setDraft(undefined);selectNote(id);};
  useEffect(()=>{if(!createdFrom)return;const added=notes.find(n=>!createdFrom.includes(n.id));if(added){selectNote(added.id);setCreatedFrom(undefined);}},[w.data,createdFrom]);
  const editable = w.role !== 'reader';
  const edit = (note?: Note) => {
    setOptions([]);
    requestAnimationFrame(()=>{readingRoot.current?.scrollIntoView({block:"start"});readingRoot.current?.querySelector<HTMLInputElement>("input")?.focus({preventScroll:true});});
    setError(''); setPreview(false);
    setDraft({ id: note?.id, version: w.version, fields: note ? { title: note.title, body: note.body, nodeIds: [...note.nodeIds], mediaIds: [...note.mediaIds], preparationIds: [...note.preparationIds], spatialIds:[...(note.spatialIds || [])] } : { title: '', body: '', nodeIds: [nodeId], mediaIds: [], preparationIds: [] } });
  };
  return <section className={`notebook-view notebook-split ${selected || draft ? 'note-open' : ''}`}>
    <aside className="notebook-index" aria-label="笔记列表">
      <div className="section-line"><h2>笔记</h2>{editable && <button className="text-button" disabled={busy} aria-label="添加笔记" onClick={()=>{if(draft&&!window.confirm('放弃未保存的修改？'))return;edit();}}><Plus size={18}/></button>}</div>
      {notes.length>0 && <label className="note-search"><input type="search" aria-label="搜索笔记" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索笔记"/></label>}
      <div className="note-list">{visibleNotes.map(n=><button className="note-list-row" aria-current={n.id===note?.id?'true':undefined} disabled={busy} ref={el=>{if(el)rows.current.set(n.id,el);else rows.current.delete(n.id);}} key={n.id} onClick={()=>choose(n.id)}><strong>{n.title}</strong><span>{noteExcerpt(noteReadingBody(n.title,n.body))}</span></button>)}</div>
      {!!notes.length && !visibleNotes.length && <p role="status">没有匹配的笔记。<button className="text-button" onClick={()=>setSearch('')}>清除搜索</button></p>}
      {!notes.length && <p className="subtle">还没有笔记</p>}
    </aside>
    <section className="notebook-reading" ref={readingRoot} tabIndex={-1} aria-label="笔记正文">
      <div className="note-toolbar"><button className="text-button note-back" disabled={busy} onClick={()=>choose('')}><ArrowLeft size={16}/>笔记列表</button>{!draft && note && editable && <button className="text-button" onClick={()=>edit(note)}><Pencil size={16}/>编辑</button>}</div>
      {draft ? (
      <form className="note-inline-editor" onSubmit={async e => {
        e.preventDefault(); if(busy)return; setBusy(true); setError('');
        try { await onSave('note', { ...(draft.id ? { noteId: draft.id } : {}), note: draft.fields }, draft.version); if(!draft.id)setCreatedFrom(notes.map(n=>n.id));setDraft(undefined); }
        catch (err) {
          setError((err as Error).message);
          if (err instanceof ApiError && err.status === 409) {
            try { onRefresh(await api<WorkspaceView>(`/api/workspaces/${w.id}`)); }
            catch { setError('无法读取最新版本，你的输入已保留。请稍后再次保存。'); }
          }
        }
        finally { setBusy(false); }
      }}>
        <label>标题<input required maxLength={160} value={draft.fields.title} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, title: e.target.value } })}/></label>
        <div className="section-line"><span>正文 · 支持 Markdown</span><button type="button" className="text-button" onClick={() => setPreview(!preview)}>{preview ? '继续编辑' : '预览'}</button></div>
        {preview ? <RichContent preserveLineEscapes text={draft.fields.body} images={options.filter(image => draft.fields.mediaIds.includes(image.id))} workspaceId={w.id}/> : <label>笔记正文<textarea rows={12} maxLength={draft.id && w.data.notebook?.[draft.id]?.origin?.kind === 'description' ? 4000 : draft.id && w.data.notebook?.[draft.id]?.origin?.kind === 'notes' ? 20000 : 100000} value={draft.fields.body} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, body: e.target.value } })}/></label>}
        <details><summary>插入已采集图片</summary>
          {optionsLoading && <p role="status">正在读取图片…</p>}
          {optionsError && <div role="alert"><p>{optionsError}</p><button type="button" onClick={() => setOptionsAttempt(value => value + 1)}>重试图片选项</button></div>}
          {!optionsLoading && !optionsError && !options.length && <p className="subtle">还没有可插入的采集图片。</p>}
          <MediaGallery images={options} selected={draft.fields.mediaIds} onSelect={id => {
            const selected = draft.fields.mediaIds.includes(id);
            setDraft({ ...draft, fields: { ...draft.fields, mediaIds: selected ? draft.fields.mediaIds.filter(value => value !== id) : [...draft.fields.mediaIds, id], body: selected ? draft.fields.body.replaceAll(`![来源图片](media:${id})`, '') : `${draft.fields.body}\n\n![来源图片](media:${id})\n` } });
          }}/>
        </details>
        <details><summary>关联设置</summary><fieldset><legend>关联计划（可多选；不选则保存在旅行资料中）</legend><div className="note-associations">
          {Object.values(w.data.nodes).map(n => <label key={n.id}><input type="checkbox" checked={draft.fields.nodeIds.includes(n.id)} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, nodeIds: e.target.checked ? [...draft.fields.nodeIds, n.id] : draft.fields.nodeIds.filter(id => id !== n.id) } })}/>{trail(w.data, n.id).map(n => n.title).join(' / ')}</label>)}
        </div></fieldset>
        <NotePlaces workspace={w} ids={draft.fields.spatialIds || []} onChange={spatialIds=>setDraft({...draft,fields:{...draft.fields,spatialIds}})}/>
        {Object.keys(w.data.preparations).length > 0 && <fieldset><legend>引用清单</legend>{Object.values(w.data.preparations).map(preparation => <label className="note-checklist-step" key={preparation.id}><input type="checkbox" checked={draft.fields.preparationIds.includes(preparation.id)} onChange={e => setDraft({...draft, fields:{...draft.fields, preparationIds:e.target.checked ? [...draft.fields.preparationIds,preparation.id] : draft.fields.preparationIds.filter(id => id !== preparation.id)}})}/>{preparation.title}</label>)}</fieldset>}
        </details>
        {draft.version !== w.version && <section className="alert warning" aria-label="笔记版本冲突">
          <p>旅行已有更新。你的输入保留在上方，请对照最新记录后决定如何保存。</p>
          {draft.id && w.data.notebook?.[draft.id] ? <details><summary>查看最新笔记与关联</summary><h3>{w.data.notebook[draft.id].title}</h3><RichContent preserveLineEscapes text={w.data.notebook[draft.id].body}/><p>关联：{w.data.notebook[draft.id].nodeIds.map(id => w.data.nodes[id]?.title).join(' · ') || '旅行资料'}</p><p>图片 {w.data.notebook[draft.id].mediaIds.length} 张；清单 {w.data.notebook[draft.id].preparationIds.length} 项</p></details> : draft.id ? <p>原笔记已被删除，可以把当前输入保存为新笔记。</p> : null}
          <button type="button" onClick={() => {setDraft({...draft, id: draft.id && w.data.notebook?.[draft.id] ? draft.id : undefined, version: w.version}); setError('');}}>已对照，保留我的输入继续保存</button>
        </section>}
        <ErrorNotice error={error}/><div className="note-edit-actions"><button type="button" disabled={busy} onClick={()=>setDraft(undefined)}>取消</button><button className="primary" disabled={busy || draft.version !== w.version}>{busy ? '保存中…' : '保存笔记'}</button></div>
      </form>
      ) : <>
    {note && <article className="note-reader">
      <h2>{note.title}</h2>

      <RichContent preserveLineEscapes text={noteReadingBody(note.title,note.body)} images={images.filter(image => note.mediaIds.includes(image.id))} workspaceId={w.id}/><MediaGallery images={images.filter(image => note.mediaIds.includes(image.id) && !note.body.includes(`media:${image.id}`))} workspaceId={w.id}/>
      <details className="note-related"><summary>关联资料</summary>
      {note.nodeIds.length>0 && <p className="subtle">{note.nodeIds.map(id=>w.data.nodes[id]?.title).join(" · ")}</p>}
      <NotePlaces workspace={w} ids={note.spatialIds || []}/>
      {note.preparationIds.map(id => {
        const preparation = w.data.preparations[id];
        if (!preparation) return null;
        return <section key={id}><h3>{preparation.title}</h3><RichContent text={preparation.note}/><p className="subtle">勾选记录个人进度</p>{preparation.steps.map(step => <label className="note-checklist-step" key={step.id}><input type="checkbox" checked={!!w.data.progress[userId]?.[step.id]} disabled={busy} onChange={async e => {
          const done = e.target.checked; setBusy(true); setError('');
          try { await onSave('progress', {stepId:step.id,done}, w.version); }
          catch (err) { setError((err as Error).message); }
          finally { setBusy(false); }
        }}/>{step.text}</label>)}</section>;
      })}
      </details>
      {editable && <details className="note-more"><summary>更多</summary><button className="text-button" disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { await onSave('deleteNote', { noteId: note.id }, w.version); selectNote(''); }
        catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
      }}><Trash2 size={16}/>删除笔记（可撤销）</button></details>}
    </article>}
      {!note && <p className="subtle">记录攻略、介绍或具体指引。</p>}
      </>}
      {mediaError && <div role="alert"><p>{mediaError}</p><button onClick={()=>setMediaAttempt(value=>value+1)}>重试读取图片</button></div>}
      <ErrorNotice error={draft?'':error}/>
    </section>
    {(children || (editable && legacyNoteCount(w.data)>0)) && <details className="notebook-extra"><summary>其他旅行资料</summary>
      {editable && legacyNoteCount(w.data)>0 && <button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await onSave('migrateNotes',{},w.version);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>整理旧资料为笔记</button>}
      {children}
    </details>}
  </section>;
}
