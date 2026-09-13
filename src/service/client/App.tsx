import { RemovePlan } from './RemovePlan';
import { KeyCards } from './Cards';
import './cards.css';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowUpRight,
  ChevronRight,
  Plus,
  Compass,
  CalendarDays,
  MapPin,
  CheckCheck,
  Menu,
  Users,
  Undo2,
  Pencil,
  FolderInput,
  Settings,
  LogOut,
  RefreshCw,
  LockKeyhole,
  ArrowLeft,
  Sparkles,
  Check,
  WifiOff,
  FileText,
} from "lucide-react";
import {
  children,
  conflicts,
  dateLabel,
  descendants,
  emptyDates,
  nodeFields,
  trail,
  type User,
  type WorkspaceView,
  type WorkspaceSummary,
  type PlanNode,
  type NodeFields,
  type Preparation,
} from "../../shared/model";
import { itineraryGroups } from "../../shared/itinerary";
import { api, post, uid, ApiError } from "./api";
import { Dialog, ErrorNotice, NodeForm, PreparationForm } from "./Forms";
import { RichContent } from "./RichContent";
import { WorkspaceMedia } from "./MediaGallery";
import { ReorderPlans } from "./ReorderPlans";
import { NotebookView } from "./NotebookView";
import { PlanMapView } from "./PlanMapView";
import { workspaceMediaTargets, type MediaMapTarget } from './map-media';
import type { MapReadingPosition } from './map-reading';
import { AgentPanel, AgentEntry, SharedEvidence } from "./AgentPanel";
import type { AgentScope } from "../../shared/agent";

type Session = { user: User | null; needsSetup: boolean; canSetup: boolean; setupRequiresToken?: boolean };
type EditModal = {
  type: "edit" | "add" | "create";
  initial?: NodeFields;
  nodeId?: string;
  parentId?: string;
  kind?: "trip" | "standalone";
  version?: number;
};
type Modal =
  | EditModal
  | { type: "prep"; preparation?: Preparation; version: number }
  | { type: "move" | "share" | "settings" | "history" | "reorder" | "removePlan" }
  | null;
const views = [
  ["计划", Compass],
  ["笔记", FileText],
  ["地图", MapPin],
] as const;
const roleName = { owner: "组织者", editor: "可编辑", reader: "只读" };
const nodeInput = (node: PlanNode) => {
  const { id, parentId, order, ...fields } = node;
  return fields;
};
const route = () => {
  const p = new URLSearchParams(location.hash.slice(1));
  return {
    workspaceId: p.get("w") || "",
    nodeId: p.get("n") || "",
    view: ({ 日期: "计划", 地点: "地图", 准备: "笔记" } as Record<string, string>)[p.get("v") || ""] || p.get("v") || "计划",
  };
};

export function App() {
  const [session, setSession] = useState<Session | null>(null),
    [list, setList] = useState<WorkspaceSummary[]>([]),
    [inventoryReady, setInventoryReady] = useState(false),
    [current, setCurrent] = useState(route),
    [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [loading, setLoading] = useState(true),
    [offline, setOffline] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [menu, setMenu] = useState(false),
    [modal, setModal] = useState<Modal>(null);
  const [agentTarget, setAgentTarget] = useState<{ scope: AgentScope; title: string; initialPrompt?: string; researchKey?: string } | null>(null);
  const [mapReturn,setMapReturn] = useState<{userId:string;workspaceId:string;nodeId:string;title:string;position:MapReadingPosition} | null>(null);
  const [mapRestore,setMapRestore] = useState<(MapReadingPosition & {key:string}) | undefined>();
  const [mapFocus,setMapFocus] = useState<{itemId:string;key:string} | undefined>();
  const [mediaReturn,setMediaReturn] = useState<{view:string;button:HTMLButtonElement;top:number;imageId:string;targetId:string} | null>(null);
  const restoredAgentFor = useRef('');
  useEffect(() => {
    if (!session?.user) return;
    if (restoredAgentFor.current !== session.user.id) {
      restoredAgentFor.current = session.user.id;
      try { const saved = JSON.parse(sessionStorage.getItem(`agent-panel:${session.user.id}`) || 'null'); if(saved?.scope && typeof saved.title === 'string') setAgentTarget(saved); } catch { /* empty or obsolete view state */ }
    }
  }, [session?.user?.id]);
  useEffect(() => { if (session?.user && restoredAgentFor.current === session.user.id) { if(agentTarget) sessionStorage.setItem(`agent-panel:${session.user.id}`,JSON.stringify({...agentTarget,initialPrompt:undefined})); else sessionStorage.removeItem(`agent-panel:${session.user.id}`); } }, [agentTarget,session?.user?.id]);
  const requestIds = useRef(new Map<string, string>()),
    currentRef = useRef(current);
  currentRef.current = current;
  const go = useCallback((id = "", node = "", view = "计划", note = "") => {
    const next = { workspaceId: id, nodeId: node, view };
    setCurrent(next);
    location.hash = new URLSearchParams({ w: id, n: node, v: view, ...(note ? {note} : {}) }).toString();
    setMenu(false);
    setError("");
  }, []);
  useEffect(()=>{setMapFocus(undefined);setMediaReturn(null);},[current.workspaceId,current.nodeId]);
  useEffect(() => {
    if (!mapReturn) return;
    if (current.workspaceId !== mapReturn.workspaceId || session?.user?.id !== mapReturn.userId) {setMapReturn(null);setMapRestore(undefined);return;}
    if (current.nodeId === mapReturn.nodeId && current.view === '地图') {
      setMapRestore({...mapReturn.position,key:uid()});setMapReturn(null);
    }
  }, [current.workspaceId,current.nodeId,current.view,mapReturn,session?.user?.id]);
  const locateMedia = (target: MediaMapTarget, button: HTMLButtonElement) => {
    setMediaReturn({view:current.view,button,top:button.getBoundingClientRect().top,imageId:button.dataset.mediaId || '',targetId:target.id});
    setMapFocus({itemId:target.itemId,key:uid()});go(current.workspaceId,current.nodeId,'地图');
  };
  const backToMedia = () => {
    if(!mediaReturn)return;
    const origin=mediaReturn;setMediaReturn(null);setMapFocus(undefined);go(current.workspaceId,current.nodeId,origin.view);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const imageSelector=`.workspace-media button[data-media-id="${CSS.escape(origin.imageId)}"]`;
      const button=origin.button.isConnected ? origin.button : document.querySelector<HTMLButtonElement>(`${imageSelector}[data-map-target="${CSS.escape(origin.targetId)}"]`) || document.querySelector<HTMLButtonElement>(`${imageSelector}.media-thumbnail`);
      if(button){button.focus({preventScroll:true});window.scrollBy({top:button.getBoundingClientRect().top-origin.top,behavior:'instant'});}
    }));
  };
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [current.workspaceId, current.nodeId, current.view]);
  const inventory = useCallback(async () => {
    const data = await api<{ workspaces: WorkspaceSummary[] }>(
      "/api/workspaces",
    );
    setList(data.workspaces);
    setInventoryReady(true);
    return data.workspaces;
  }, []);
  async function refreshSession() {
    const s = await api<Session>("/api/session");
    setSession(s);
    if (s.user) await inventory();
    setLoading(false);
    setOffline(false);
  }
  useEffect(() => {
    refreshSession().catch((e) => {
      setError(e.message);
      setLoading(false);
    });
    const handle = () => setCurrent(route());
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, []);
  useEffect(() => {
    if (!session?.user || !current.workspaceId) {
      setWorkspace(null);
      return;
    }
    let live = true,
      inFlight = false;
    setLoading(true);
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const w = await api<WorkspaceView>(
          `/api/workspaces/${current.workspaceId}`,
        );
        if (live) {
          setWorkspace((old) =>
            JSON.stringify(old) === JSON.stringify(w) ? old : w,
          );
          setLoading(false);
          setOffline(false);
        }
      } catch (e) {
        if (live) {
          setLoading(false);
          setOffline(![401, 403, 404].includes((e as ApiError).status));
          if ((e as ApiError).status === 401)
            setSession((s) => (s ? { ...s, user: null } : null));
          if (
            (e as ApiError).status === 403 ||
            (e as ApiError).status === 404
          ) {
            setWorkspace(null);
            setError((e as Error).message);
          }
        }
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(load, 2500);
    const online = () => void load();
    window.addEventListener("online", online);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("online", online);
    };
  }, [session?.user?.id, current.workspaceId]);
  useEffect(() => {
    if (!session?.user) return;
    const timer = setInterval(
      () =>
        inventory()
          .then(() => {
            if (!currentRef.current.workspaceId) setOffline(false);
          })
          .catch(() => setOffline(true)),
      5000,
    );
    return () => clearInterval(timer);
  }, [session?.user?.id, inventory]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function mutate(
    kind: string,
    payload: Record<string, unknown>,
    id?: string,
    version?: number,
  ) {
    const draft = {
        kind,
        payload,
        ...(id ? { workspaceId: id, version } : {}),
      },
      key = JSON.stringify(draft);
    const requestId = requestIds.current.get(key) || uid();
    requestIds.current.set(key, requestId);
    setSaving(true);
    try {
      const result = await post<{ workspaceId: string; changeId: string }>(
        "/api/commands",
        { ...draft, requestId },
      );
      requestIds.current.delete(key);
      setNotice("已保存到本机");
      setOffline(false);
      try {
        const available = await inventory();
        if (!available.some((item) => item.id === result.workspaceId)) {
          setWorkspace(null);
          go();
          return result;
        }
        if (result.workspaceId) {
          const updated = await api<WorkspaceView>(
            `/api/workspaces/${result.workspaceId}`,
          );
          setWorkspace(updated);
          if (result.workspaceId !== currentRef.current.workspaceId)
            go(updated.id, updated.data.rootId);
        }
      } catch {
        setNotice("修改已保存；暂时无法刷新，恢复连接后会自动同步。");
      }
      return result;
    } finally {
      setSaving(false);
    }
  }
  async function undo(changeId: string) {
    try {
      await mutate("undo", { changeId });
      setModal(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const w = workspace?.id === current.workspaceId ? workspace : null;
  const node =
    w && (w.data.nodes[current.nodeId] || w.data.nodes[w.data.rootId]);
  const editable = w && w.role !== "reader";
  const user = session?.user;
  const sectionNodes = w && node ? descendants(w.data, node.id) : [];
  const relevant = new Set(sectionNodes.map((n) => n.id));
  const issues = w
    ? conflicts(w.data).filter((c) => relevant.has(c.nodeId))
    : [];
  const visiblePreps = w
    ? Object.values(w.data.preparations).filter((p) =>
        p.nodeIds.some((id) => relevant.has(id)),
      )
    : [];
  const latestUndo = w?.history.find((h) => h.canUndo);
  if (!session || !user)
    return (
      <>
        <Header />
        <main className="auth-page">
          {loading ? (
            <p role="status">正在打开工作区…</p>
          ) : session ? (
            <AuthScreen
              session={session}
              onSuccess={async (id) => {
                await refreshSession();
                if (id) go(id);
              }}
            />
          ) : (
            <div className="auth-card">
              <ErrorNotice error={error} />
              <button
                onClick={() => {
                  setLoading(true);
                  refreshSession().catch((e) => {
                    setError(e.message);
                    setLoading(false);
                  });
                }}
              >
                重新连接
              </button>
            </div>
          )}
        </main>
      </>
    );
  const openCreate = (kind: "trip" | "standalone") =>
    setModal({ type: "create", kind });
  const renderTree = (parent: string, depth = 0): React.ReactNode =>
    w && depth < 12
      ? children(w.data, parent).map((n) => (
          <div key={n.id}>
            <button
              className={`nav-item child ${node?.id === n.id ? "active" : ""}`}
              style={{ paddingLeft: Math.min(depth, 4) * 12 + 16 }}
              onClick={() => go(w.id, n.id)}
            >
              <span className="tree-dot" />
              {n.title}
            </button>
            {renderTree(n.id, depth + 1)}
          </div>
        ))
      : null;
  return (
    <div className="shell">
      <Header>
        <button
          className="mobile-menu icon-button"
          aria-label={menu ? "收起旅行导航" : "打开旅行导航"}
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <Menu size={20} />
        </button>
        <span
          className={`save-status ${offline ? "warning" : ""}`}
          role="status"
        >
          {saving ? (
            "正在保存…"
          ) : offline ? (
            <>
              <WifiOff size={15} />
              连接中断
            </>
          ) : !inventoryReady || (loading && !w) ? (
            "正在读取…"
          ) : (
            <>
              <Check size={15} />
              本机已保存
            </>
          )}
        </span>
        <button
          className="account-button"
          onClick={() => setModal({ type: "settings" })}
        >
          <span className="avatar">{user.name.slice(0, 1)}</span>
          <span className="account-name">{user.name}</span>
        </button>
      </Header>
      <div className="workspace">
        <aside
          className={`sidebar ${menu ? "mobile-open" : ""}`}
          aria-label="旅行导航"
        >
          <button
            className={`nav-item ${!current.workspaceId ? "active" : ""}`}
            onClick={() => go()}
          >
            <Compass size={18} />
            所有旅行
          </button>
          <div className="section-line">
            <span className="overline">我的旅行</span>
            <button
              className="icon-button"
              aria-label="新建旅行"
              onClick={() => openCreate("trip")}
            >
              <Plus size={18} />
            </button>
          </div>
          {list
            .filter((item) => item.kind === "trip")
            .map((item) => (
              <div key={item.id}>
                <button
                  className={`nav-item ${current.workspaceId === item.id && node?.id === w?.data.rootId ? "active" : ""}`}
                  onClick={() => go(item.id)}
                >
                  <Compass size={17} />
                  <span>{item.title}</span>
                </button>
                {current.workspaceId === item.id &&
                  w &&
                  renderTree(w.data.rootId)}
              </div>
            ))}
          {!list.some((item) => item.kind === "trip") && (
            <p className="subtle nav-empty">
              {inventoryReady
                ? "还没有旅行"
                : offline
                  ? "等待恢复连接"
                  : "正在读取旅行…"}
            </p>
          )}
          <div className="sidebar-footer">
            <div className="section-line">
              <span className="overline">独立计划</span>
              <button
                className="icon-button"
                aria-label="新建独立计划"
                onClick={() => openCreate("standalone")}
              >
                <Plus size={18} />
              </button>
            </div>
            {list
              .filter((item) => item.kind === "standalone")
              .map((item) => (
                <button
                  className={`nav-item ${item.id === current.workspaceId ? "active" : ""}`}
                  onClick={() => go(item.id)}
                  key={item.id}
                >
                  <FileText size={16} />
                  {item.title}
                </button>
              ))}
            {!list.some((item) => item.kind === "standalone") && (
              <p className="subtle">
                {inventoryReady
                  ? "从一天或一个活动开始。"
                  : offline
                    ? "等待恢复连接"
                    : "正在读取独立计划…"}
              </p>
            )}
          </div>
          <button
            className="nav-item settings-link"
            onClick={() => setModal({ type: "settings" })}
          >
            <Settings size={17} />
            连接与备份
          </button>
        </aside>
        <main className={`main ${current.view==='地图' ? 'map-page' : ''}`} id="main-content">
          <ErrorNotice error={error} />
          {offline && w && (
            <div className="alert warning" role="status">
              <WifiOff size={18} />
              <span>
                连接中断，正在展示上次读取的内容。恢复后会同步最新计划。
              </span>
            </div>
          )}
          {!current.workspaceId ? (
            <>
              <div className="page-toolbar">
                <div>
                  <p className="overline">旅行工作区</p>
                  <h1>我的旅行</h1>
                  <p className="lead">
                    从一趟旅行开始，也可以先整理一天的想法。
                  </p>
                </div>
                <button className="primary" onClick={() => openCreate("trip")}>
                  <Plus size={17} />
                  新建旅行
                </button>
              </div>
              <div className="overview-grid">
                {list.map((item) => (
                  <button
                    className="trip-card"
                    key={item.id}
                    onClick={() => go(item.id)}
                  >
                    <div
                      className={`trip-icon ${item.kind === "standalone" ? "violet" : ""}`}
                    >
                      <Compass size={23} />
                    </div>
                    <h2>{item.title}</h2>
                    <p className="subtle">{dateLabel(item.dates)}</p>
                    <div className="card-meta">
                      <span>
                        {item.kind === "trip" ? "旅行" : "独立计划"} ·{" "}
                        {item.count} 项内容
                      </span>
                      <span>{roleName[item.role]}</span>
                    </div>
                    {item.sample && (
                      <span className="sample-label">验收示例</span>
                    )}
                  </button>
                ))}
              </div>
              {!inventoryReady && (
                <p className="loading-state" role="status">
                  {offline
                    ? "暂时无法读取旅行列表，连接恢复后会自动重试。"
                    : "正在读取旅行列表…"}
                </p>
              )}
              {inventoryReady && !list.length && (
                <div className="empty-panel">
                  <Compass size={34} />
                  <h2>还没有旅行计划</h2>
                  <p>先记下想去哪里，日期和细节可以稍后补充。</p>
                  <div className="button-row">
                    <button onClick={() => openCreate("standalone")}>
                      创建独立计划
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await mutate("sample", {});
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                      disabled={saving}
                    >
                      载入意大利示例
                    </button>
                  </div>
                </div>
              )}
              <AgentEntry onOpen={() => setAgentTarget({ scope: { workspaceId: null, nodeId: null }, title: "新独立计划" })} />
            </>
          ) : loading && !w ? (
            <p className="loading-state" role="status">
              正在读取计划…
            </p>
          ) : w && node ? (
            <>
              {mapReturn && mapReturn.workspaceId===w.id && w.data.nodes[mapReturn.nodeId] && <button className="text-button map-back-media" onClick={()=>go(mapReturn.workspaceId,mapReturn.nodeId,'地图')}><ArrowLeft size={16}/>返回「{mapReturn.title}」地图</button>}
              <nav className="breadcrumbs" aria-label="当前计划位置">
                <button onClick={() => go()}>我的旅行</button>
                {trail(w.data, node.id).map((n) => (
                  <span className="crumb" key={n.id}>
                    <ChevronRight size={14} />
                    <button
                      title={n.title}
                      aria-current={node.id === n.id ? "page" : undefined}
                      onClick={() => go(w.id, n.id)}
                    >
                      {n.title}
                    </button>
                  </span>
                ))}
              </nav>
              <div className="page-toolbar">
                <div className="title-content">
                  <div className="eyebrow-row">
                    {w.data.sample && (
                      <span className="sample-label">
                        验收示例 · 非真实预订
                      </span>
                    )}
                  </div>
                  <h1>{node.title}</h1>
                </div>
                <div className="toolbar-actions">
                  <AgentEntry onOpen={() => setAgentTarget({ scope: { workspaceId: w.id, nodeId: node.id }, title: node.title })}/>
                  <details className="plan-management"><summary>更多</summary><div>
                  <button
                    aria-label="修改记录"
                    onClick={() => setModal({ type: "history" })}
                  >
                    <Undo2 size={18} />
                    <span>修改记录</span>
                  </button>
                  {w.data.kind === "trip" && (
                    <button onClick={() => setModal({ type: "share" })}>
                      <Users size={17} />
                      <span>同行</span>
                    </button>
                  )}
                  {editable && (
                    <button
                      className="primary"
                      onClick={() =>
                        setModal({
                          type: "edit",
                          nodeId: node.id,
                          initial: nodeInput(node),
                          version: w.version,
                        })
                      }
                    >
                      <Pencil size={16} />
                      <span>编辑</span>
                    </button>
                  )}
                  </div></details>
                </div>
              </div>
              <div className="trip-meta">
                <CalendarDays size={17} />
                <span>{dateLabel(node.dates)}</span>
                {node.fixed && (
                  <span className="fixed-label">
                    <LockKeyhole size={14} />
                    固定安排
                  </span>
                )}

              </div>
              {issues.length > 0 && (
                <div className="alert warning">
                  <span>需要检查</span>
                  <ul>
                    {issues.map((c, i) => (
                      <li key={i}>
                        <button
                          className="text-button"
                          onClick={() => go(w.id, c.nodeId, "计划")}
                        >
                          {c.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="tabs" role="group" aria-label="查看方式">
                {views.map(([label, Icon]) => (
                  <button
                    key={label}
                    aria-pressed={current.view === label}
                    className={current.view === label ? "selected" : ""}
                    onClick={() => go(w.id, node.id, label)}
                  >
                    <Icon size={17} />
                    {label}

                  </button>
                ))}
              </div>
              {current.view === "计划" && (
                <>
                  <KeyCards key={`${w.id}:${node.id}`} workspace={w} nodeId={node.id} onSave={mutate}/>
                  <div className="section-line">
                    <h2>
                      {children(w.data, node.id).length
                        ? "行程安排"
                        : "这部分的安排"}
                    </h2>
                    {editable && (
                      <button
                        className="text-button"
                        onClick={() =>
                          setModal({
                            type: "add",
                            parentId: node.id,
                            version: w.version,
                          })
                        }
                      >
                        <Plus size={17} />
                        添加子计划
                      </button>
                    )}
                  </div>
                  {editable && children(w.data,node.id).length>1 && <button className="text-button" onClick={()=>setModal({type:'reorder'})}>调整顺序</button>}
                  {modal?.type==='reorder' && <ReorderPlans workspace={w} parentId={node.id} onClose={()=>setModal(null)} onSave={(nodeIds,version)=>mutate('reorder',{parentId:node.id,nodeIds},w.id,version)}/>}
                  {itineraryGroups(w.data, node.id).map(group => (
                    <section className="itinerary-group" key={group.key} aria-label={group.label}>
                      <h3>{group.label}</h3>
                      <div className="plan-list">
                        {group.nodes.map(n => <PlanRow key={n.id} node={n} onClick={() => go(w.id, n.id)} />)}
                      </div>
                    </section>
                  ))}
                  {!children(w.data, node.id).length && !node.description && (
                    <div className="leaf-panel">
                      <p>
                        这里还没有具体安排，可以添加子计划，或者先保留这个想法。
                      </p>
                      {node.kind === "free" && (
                        <span className="badge">保留自由时间</span>
                      )}
                    </div>
                  )}
                  {node.preference && (
                    <div className="info-line">
                      <strong>偏好</strong>
                      <span>{node.preference}</span>
                    </div>
                  )}
                  <div className="context-actions">
                    {editable &&
                      (node.id !== w.data.rootId ||
                        w.data.kind === "standalone") && (
                        <button onClick={() => setModal({ type: "move" })}>
                          <FolderInput size={16} />
                          {node.id === w.data.rootId
                            ? "加入已有旅行"
                            : "调整归属"}
                        </button>
                      )}
                    {editable && node.id!==w.data.rootId && <button onClick={()=>setModal({type:'removePlan'})}>移出行程</button>}
                    {visiblePreps.length > 0 && (
                      <button onClick={() => go(w.id, node.id, "笔记")}>
                        <CheckCheck size={16} />
                        查看相关清单
                      </button>
                    )}
                    {latestUndo && (
                      <button
                        onClick={() => undo(latestUndo.id)}
                        disabled={saving}
                      >
                        <Undo2 size={16} />
                        撤销上次修改
                      </button>
                    )}
                  </div>
                </>
              )}
              {current.view === "地图" && (
                <PlanMapView key={`${w.id}:${node.id}`} workspace={w} nodeId={node.id} userId={session.user!.id} focus={mapFocus} onFocusDone={()=>setMapFocus(undefined)} onBackToMedia={mediaReturn ? backToMedia : undefined} restore={mapRestore} onRestored={()=>setMapRestore(undefined)} onOpen={(id,position) => {setMapReturn({userId:session.user!.id,workspaceId:w.id,nodeId:node.id,title:node.title,position});go(w.id,id);}} onResearchPlace={asset=>setAgentTarget({scope:{workspaceId:w.id,nodeId:node.id},title:`${asset.name} · 看点与指引`,researchKey:asset.id,initialPrompt:`请研究这个地图候选，整理成可保存的中文图文攻略：${asset.name}。
地址：${asset.address || '待核对'}
地点数据来源：${asset.source.url}

请先核对地点身份，优先查阅官方网站，说明2—3个具体看点、适合什么兴趣、参观或预约指引，并为各项事实附来源链接和查阅日期。找不到依据的内容明确标为待核对，不从地点名称猜测评价。不虚构图片、开放时间或绕行耗时。结合当前行程说明是否值得额外停留；不修改行程、不自动采用地点。`})} onOpenNote={(noteId,position)=>{setMapReturn({userId:session.user!.id,workspaceId:w.id,nodeId:node.id,title:node.title,position});go(w.id,w.data.rootId,"笔记",noteId);}} onSavePlace={(assetId,version)=>mutate("savePlaceNote",{assetId},w.id,version)} onAdopt={(assetId,version,beforeNodeId) => mutate("adoptPlace",{parentId:node.id,assetId,beforeNodeId},w.id,version)} onBind={(nodeId, bindings, version) => mutate("spatial", { nodeId, bindings }, w.id, version)} />
              )}
              {current.view === "笔记" && (
                <>
                  <NotebookView key={`${w.id}:${node.id}`} workspace={w} nodeId={node.id} userId={session.user!.id} onRefresh={setWorkspace} onSave={(kind,payload,version) => mutate(kind,payload,w.id,version)}>
                  <details className="legacy-notes"><summary>已有介绍、配图与清单</summary>
              {node.description && <div className="lead"><RichContent text={node.description}/></div>}
              <WorkspaceMedia workspaceId={w.id} nodeId={node.id} version={w.version} editable={!!editable} onSave={(ids,baseVersion) => mutate("media", {nodeId: node.id, mediaIds: ids}, w.id, baseVersion)} mapTargets={workspaceMediaTargets(w.data,node.id)} onLocate={locateMedia}/>

                  {node.notes && <section><h3>原有备注</h3><RichContent text={node.notes}/></section>}
                  <div className="section-line">
                    <h2>相关清单</h2>
                    {editable && (
                      <button
                        className="text-button"
                        onClick={() =>
                          setModal({ type: "prep", version: w.version })
                        }
                      >
                        <Plus size={17} />
                        添加准备
                      </button>
                    )}
                  </div>
                  <p className="subtle view-intro">
                    清单内容与同行者共用，勾选只记录你自己的进度，不代表已经预订或核实。
                  </p>
                  {visiblePreps.length === 0 && (
                    <div className="empty-panel compact">
                      <CheckCheck size={28} />
                      <p>还没有关联到这里的准备事项。</p>
                    </div>
                  )}
                  {visiblePreps.map((p) => (
                    <section className="prep-card" key={p.id}>
                      <div className="section-line">
                        <h3>{p.title}</h3>
                        {editable && (
                          <button
                            className="icon-button"
                            aria-label={`编辑准备事项：${p.title}`}
                            onClick={() =>
                              setModal({
                                type: "prep",
                                preparation: p,
                                version: w.version,
                              })
                            }
                          >
                            <Pencil size={16} />
                          </button>
                        )}
                      </div>
                      {p.note && <p className="subtle prep-note">{p.note}</p>}
                      <div className="prep-steps">
                        {p.steps.map((step) => (
                          <label className="check-line" key={step.id}>
                            <input
                              type="checkbox"
                              checked={!!w.data.progress[user.id]?.[step.id]}
                              disabled={saving}
                              onChange={async (e) => {
                                try {
                                  await mutate(
                                    "progress",
                                    { stepId: step.id, done: e.target.checked },
                                    w.id,
                                    w.version,
                                  );
                                } catch (err) {
                                  setError((err as Error).message);
                                }
                              }}
                            />
                            <span>{step.text}</span>
                          </label>
                        ))}
                      </div>
                      <div className="prep-footer">
                        <span>
                          {
                            p.steps.filter(
                              (s) => w.data.progress[user.id]?.[s.id],
                            ).length
                          }
                          /{p.steps.length} 已完成
                        </span>
                        <div>
                          关联：
                          {p.nodeIds.map((id) => (
                            <button
                              className="text-button"
                              key={id}
                              onClick={() => go(w.id, id)}
                            >
                              {w.data.nodes[id]?.title}
                            </button>
                          ))}
                        </div>
                      </div>
                    </section>
                  ))}
                  </details>
                  </NotebookView>
                </>
              )}
              <SharedEvidence workspaceId={w.id} version={w.version} onReview={() => setAgentTarget({ scope: { workspaceId: w.id, nodeId: node.id }, title: node.title, initialPrompt: "请按当前日期和地点重新核对开放、预约及票种条件。" })} />

            </>
          ) : (
            <div className="empty-panel">
              <p>选择一份旅行继续规划。</p>
              <button onClick={() => go()}>返回我的旅行</button>
            </div>
          )}
        </main>
      </div>
      {agentTarget && session?.user && <AgentPanel key={`${agentTarget.scope.workspaceId}:${agentTarget.scope.nodeId}:${agentTarget.researchKey || ""}`} userId={session.user.id} {...agentTarget} names={Object.fromEntries(Object.values(w?.data.nodes || {}).map(n => [n.id, n.title]))} onClose={() => setAgentTarget(null)} onApplied={async id => { await inventory(); const updated = await api<WorkspaceView>(`/api/workspaces/${id}`); setWorkspace(updated); const previous = currentRef.current; go(id, previous.workspaceId === id && updated.data.nodes[previous.nodeId] ? previous.nodeId : updated.data.rootId, previous.workspaceId === id ? previous.view : "计划"); setNotice("AI 建议已采用，可在研究记录或修改历史中撤销。"); }} onNoteSaved={async id=>{await inventory();const updated=await api<WorkspaceView>(`/api/workspaces/${id}`);setWorkspace(updated);go(id,updated.data.rootId,"笔记");setNotice("研究已保存到笔记，行程未改变。");}} onUndo={async changeId => mutate("undo", { changeId })} />}
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
      {modal &&
        ["edit", "add", "create"].includes(modal.type) &&
        (() => {
          const m = modal as EditModal;
          return (
            <NodeForm
              key={`${m.type}-${m.nodeId || m.parentId || m.kind}`}
              title={
                m.type === "edit"
                  ? "编辑计划"
                  : m.type === "add"
                    ? "添加子计划"
                    : m.kind === "trip"
                      ? "新建旅行"
                      : "新建独立计划"
              }
              initial={m.initial}
              locationReferences={w && m.type !== 'create' ? trail(w.data, (m.type === 'edit' ? w.data.nodes[m.nodeId!]?.parentId : m.parentId) || w.data.rootId).filter(n => n.id !== m.nodeId && n.location.lat !== null && n.location.lng !== null).reverse().slice(0,1).map(n => n.location) : []}
              context={
                m.type === "create"
                  ? "日期和地点可以留空，稍后继续完善。"
                  : `保存到：${node?.title || ""}`
              }
              onClose={() => setModal(null)}
              onSave={async (n, confirm) => {
                if (m.type === "create")
                  await mutate("create", { kind: m.kind, node: n });
                else if (w)
                  await mutate(
                    m.type === "edit" ? "edit" : "add",
                    m.type === "edit"
                      ? { nodeId: m.nodeId, node: n, confirmFixed: confirm }
                      : { parentId: m.parentId, node: n },
                    w.id,
                    m.version,
                  );
              }}
              onRebase={
                m.type === "create"
                  ? undefined
                  : async () => {
                      const latest = await api<WorkspaceView>(
                        `/api/workspaces/${w!.id}`,
                      );
                      setWorkspace(latest);
                      setModal((old) =>
                        old && "version" in old
                          ? { ...old, version: latest.version }
                          : old,
                      );
                      const saved = latest.data.nodes[m.nodeId || m.parentId!];
                      return saved
                        ? [
                            `名称：${saved.title}`,
                            `类型：${{plan:"计划",activity:"具体活动",free:"自由时间"}[saved.kind]}`,
                            `日期：${dateLabel(saved.dates)}`,
                            `时刻：${saved.dates.startTime || "未定"} — ${saved.dates.endTime || "未定"}（${saved.dates.timezone}）`,
                            `固定安排：${saved.fixed ? "是" : "否"}`,
                            `说明：${saved.description || "未填写"}`,
                            `偏好：${saved.preference || "未填写"}`,
                            `备注：${saved.notes || "未填写"}`,
                            `地点：${saved.location.name || "未填写"}`,
                            `地址：${saved.location.address || "未填写"}`,
                            `坐标：${saved.location.lat === null ? "未填写" : `${saved.location.lat}, ${saved.location.lng}`}`,
                          ].join("\n")
                        : "原记录已不存在，请取消后重新选择。";
                    }
              }
            />
          );
        })()}
      {modal?.type === "prep" && w && node && (
        <PreparationForm
          workspace={w}
          nodeId={node.id}
          initial={modal.preparation}
          onClose={() => setModal(null)}
          onRebase={async () => {
            const latest = await api<WorkspaceView>(`/api/workspaces/${w.id}`);
            setWorkspace(latest);
            setModal((old) =>
              old?.type === "prep" ? { ...old, version: latest.version } : old,
            );
            const p =
              modal.preparation &&
              latest.data.preparations[modal.preparation.id];
            return p
              ? [`名称：${p.title}`,`说明：${p.note || "未填写"}`,`步骤：\n${p.steps.map((s,i) => `${i+1}. ${s.text}`).join("\n")}`,`关联计划：${p.nodeIds.map(id=>trail(latest.data,id).map(n=>n.title).join(" › ")).join("；")}`].join("\n")
              : "已载入旅行的最新版本";
          }}
          onSave={async (p) => {
            await mutate(
              "prep",
              {
                ...(modal.preparation ? { prepId: modal.preparation.id } : {}),
                preparation: p,
              },
              w.id,
              modal.version,
            );
          }}
        />
      )}
      {modal?.type === 'removePlan' && w && node && <RemovePlan workspace={w} nodeId={node.id} onClose={()=>setModal(null)} onSave={async(version,confirmFixed)=>{const parentId=node.parentId!;await mutate('removePlan',{nodeId:node.id,confirmFixed},w.id,version);setModal(null);go(w.id,parentId);}}/>}
      {modal?.type === "move" && w && node && (
        <MoveDialog
          workspace={w}
          node={node}
          list={list}
          onClose={() => setModal(null)}
          onSave={async (kind, payload, version) => {
            await mutate(kind, payload, w.id, version);
          }}
        />
      )}
      {modal?.type === "share" && w && (
        <ShareDialog workspace={w} onClose={() => setModal(null)} />
      )}
      {modal?.type === "settings" && (
        <SettingsDialog
          user={user}
          onClose={() => setModal(null)}
          onJoined={(id) => {
            setModal(null);
            void inventory();
            go(id);
          }}
          onLogout={async () => {
            await post("/api/logout", {});
            setModal(null);
            setWorkspace(null);
            setList([]);
            setInventoryReady(false);
            setSession((s) => (s ? { ...s, user: null } : null));
            go();
          }}
        />
      )}
      {modal?.type === "history" && w && (
        <Dialog title="修改记录" onClose={() => setModal(null)}>
          <div className="dialog-body">
            <p className="subtle view-intro">
              只能直接撤销没有后续修改的一笔操作，避免覆盖同行者的内容。
            </p>
            {w.history.map((h) => (
              <div className="history-row" key={h.id}>
                <div>
                  <strong>{h.label}</strong>
                  <p className="subtle">
                    {h.actor} · {new Date(h.time).toLocaleString("zh-CN")}
                  </p>
                </div>
                {h.canUndo && (
                  <button onClick={() => undo(h.id)} disabled={saving}>
                    撤销
                  </button>
                )}
              </div>
            ))}
            {!w.history.length && <p>还没有修改记录。</p>}
          </div>
        </Dialog>
      )}
    </div>
  );
}
function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <span className="brand-mark">
          <ArrowUpRight size={23} />
        </span>
        行间<span className="brand-sub">旅行工作区</span>
      </a>
      <div className="top-actions">{children}</div>
    </header>
  );
}
function PlanRow({ node, onClick }: { node: PlanNode; onClick: () => void }) {
  const dated = node.dates.mode === "fixed" || node.dates.mode === "window";
  return (
    <button className="plan-row" onClick={onClick}>
      <span className="date-block">
        {dated ? <>{`${Number(node.dates.start.slice(5, 7))} 月`}<strong>{node.dates.start.slice(8)}</strong></> : <CalendarDays size={20} aria-hidden="true"/>}
      </span>
      <span>
        <span className="plan-title">
          {node.title}
          {node.fixed && <LockKeyhole size={14} />}
        </span>
        {node.description && (
          <span className="plan-description">{node.description}</span>
        )}
        <span className="plan-meta">
          {dateLabel(node.dates)}{node.dates.startTime ? ` · ${node.dates.timezone}` : ''}
          {node.kind === "free" ? " · 自由时间" : ""}
        </span>
      </span>
      <ChevronRight size={18} />
    </button>
  );
}
function AuthScreen({
  session,
  onSuccess,
}: {
  session: Session;
  onSuccess: (id?: string) => Promise<void>;
}) {
  const [mode, setMode] = useState(
    new URLSearchParams(location.search).has("invite")
      ? "join"
      : session.needsSetup
        ? "setup"
        : "login",
  );
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [token, setToken] = useState(
      new URLSearchParams(location.search).get("invite") || "",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [setupToken, setSetupToken] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const credential = { username, password, ...(name ? { name } : {}) };
      const result = await api<{ workspaceId?: string }>(
        `/api/${mode === "join" ? "join" : mode}`,
        {method:"POST",headers: mode==="setup" && session.setupRequiresToken ? {"x-setup-token":setupToken}: {},body:JSON.stringify(mode === "join" ? { token, credentials: credential } : credential)},
      );
      if (mode === "join")
        history.replaceState(null, "", location.pathname + location.hash);
      await onSuccess(result.workspaceId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (session.needsSetup && !session.canSetup)
    return (
      <div className="auth-card">
        <h1>等待本机完成设置</h1>
        <p>
          请先在部署电脑打开 localhost 地址建立组织者账号，再通过邀请加入旅行。
        </p>
        <button onClick={() => location.reload()}>重新检查</button>
      </div>
    );
  return (
    <form className="auth-card" onSubmit={submit}>
      <span className="trip-icon">
        <Compass size={26} />
      </span>
      <h1>
        {mode === "setup"
          ? "建立你的旅行工作区"
          : mode === "join"
            ? "加入同行者的旅行"
            : "回到你的旅行"}
      </h1>
      <p className="subtle">
        {mode === "setup"
          ? "设置本机账号。手机上也可以使用这个账号登录。"
          : mode === "join"
            ? "使用一次性邀请码建立自己的账号，准备进度分别保存。"
            : "使用本机账号登录，继续已保存的安排。"}
      </p>
      {mode === "join" && (
        <label>
          邀请码
          <input
            required
            value={token}
            onChange={(e) => setToken(e.target.value.trim())}
          />
        </label>
      )}
      {mode === "setup" && session.setupRequiresToken && <label>安装凭据<input type="password" required autoComplete="off" value={setupToken} onChange={e=>setSetupToken(e.target.value.trim())}/><span className="subtle">填写安装完成时提供的凭据；建立账号后不再需要。</span></label>}
      <label>
        用户名
        <input
          autoFocus
          required
          minLength={2}
          maxLength={40}
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      {mode !== "login" && (
        <label>
          显示名称
          <input
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      <label>
        密码
        <input
          type="password"
          required
          minLength={8}
          maxLength={128}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <ErrorNotice error={error} />
      <button className="primary full-width" disabled={busy}>
        {busy
          ? "正在处理…"
          : mode === "setup"
            ? "建立工作区"
            : mode === "join"
              ? "加入旅行"
              : "登录"}
      </button>
      {!session.needsSetup && (
        <button
          type="button"
          className="text-button full-width"
          onClick={() => {
            setMode(mode === "join" ? "login" : "join");
            setError("");
          }}
        >
          {mode === "join" ? "已有账号，先登录" : "有同行者的邀请码？"}
        </button>
      )}
    </form>
  );
}
function MoveDialog({
  workspace,
  node,
  list,
  onSave,
  onClose,
}: {
  workspace: WorkspaceView;
  node: PlanNode;
  list: WorkspaceSummary[];
  onSave: (
    kind: string,
    payload: Record<string, unknown>,
    version: number,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [baseVersion, setBaseVersion] = useState(workspace.version);
  const [conflicted, setConflicted] = useState(false);
  const root = node.id === workspace.data.rootId,
    [targetId, setTarget] = useState(root ? "" : workspace.id),
    [parentId, setParent] = useState(root ? "" : node.parentId || ""),
    [target, setTargetData] = useState<WorkspaceView | null>(
      root ? null : workspace,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const invalid = new Set(
    descendants(workspace.data, node.id).map((n) => n.id),
  );
  return (
    <Dialog title={root ? "加入已有旅行" : "调整计划归属"} onClose={onClose} busy={busy}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave(
              root ? "merge" : "move",
              root
                ? { targetId, targetVersion: target!.version, parentId }
                : { nodeId: node.id, parentId },
              baseVersion,
            );
            onClose();
          } catch (err) {
            setError((err as Error).message);
            if (err instanceof ApiError && err.status === 409)
              setConflicted(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <p className="form-context">
            “{node.title}”及其子内容、日期和准备状态会一并保留。
          </p>
          {root && workspace.data.kind === "trip" ? (
            <p>当前已经是一趟旅行。请选择其中的子计划调整归属。</p>
          ) : (
            <>
              {root && (
                <label>
                  目标旅行
                  <select
                    required
                    value={targetId}
                    onChange={async (e) => {
                      setTarget(e.target.value);
                      setParent("");
                      setTargetData(null);
                      try {
                        const w = await api<WorkspaceView>(
                          `/api/workspaces/${e.target.value}`,
                        );
                        setTargetData(w);
                        setParent(w.data.rootId);
                      } catch (err) {
                        setError((err as Error).message);
                      }
                    }}
                  >
                    <option value="">选择已有旅行</option>
                    {list
                      .filter(
                        (w) =>
                          w.kind === "trip" &&
                          w.role !== "reader" &&
                          w.id !== workspace.id,
                      )
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.title}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label>
                放在哪个计划下
                <select
                  required
                  value={parentId}
                  onChange={(e) => setParent(e.target.value)}
                >
                  <option value="">选择上级计划</option>
                  {target &&
                    Object.values(target.data.nodes)
                      .filter((n) => root || !invalid.has(n.id))
                      .map((n) => (
                        <option key={n.id} value={n.id}>
                          {trail(target.data, n.id)
                            .map((p) => p.title)
                            .join(" › ")}
                        </option>
                      ))}
                </select>
              </label>
              {root && (
                <div className="alert warning">
                  归并后，目标旅行的成员可以看到这个独立计划的全部内容、备注和相关准备。
                </div>
              )}
              <p className="subtle">
                已有日期不会自动平移；若超出目标范围，保存后会显示冲突提示。
              </p>
            </>
          )}
          <ErrorNotice error={error} />
          {conflicted && (
            <button
              type="button"
              onClick={async () => {
                try {
                  const latest = await api<WorkspaceView>(
                    `/api/workspaces/${workspace.id}`,
                  );
                  const latestTarget = root
                    ? await api<WorkspaceView>(`/api/workspaces/${targetId}`)
                    : latest;
                  setBaseVersion(latest.version);
                  setTargetData(latestTarget);
                  setConflicted(false);
                  setError("已更新计划版本，请核对目标位置后再次保存。");
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              载入最新版本并保留目标选择
            </button>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              conflicted ||
              !parentId ||
              (root && workspace.data.kind === "trip")
            }
          >
            {busy ? "正在保存…" : "保存归属"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function ShareDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceView;
  onClose: () => void;
}) {
  const [role, setRole] = useState("reader"),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [invites, setInvites] = useState<
      { id: string; role: "reader" | "editor"; expires: number; used: number }[]
    >([]);
  const refresh = () =>
    api<{ invites: typeof invites }>(
      `/api/workspaces/${workspace.id}/invites`,
    ).then((r) => setInvites(r.invites));
  useEffect(() => {
    if (workspace.role === "owner")
      void refresh().catch((e) => setError(e.message));
  }, []);
  return (
    <Dialog title="同行者与共享" onClose={onClose}>
      <div className="dialog-body">
        <h3>{workspace.data.nodes[workspace.data.rootId].title}</h3>
        <div className="member-list">
          {workspace.members.map((m) => (
            <div key={m.id}>
              <span className="avatar">{m.name.slice(0, 1)}</span>
              <span>{m.name}</span>
              <span className="badge">{roleName[m.role]}</span>
            </div>
          ))}
        </div>
        {workspace.role === "owner" && (
          <>
            <label>
              新同行者的权限
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="reader">
                  只读共享计划，可更新自己的准备进度
                </option>
                <option value="editor">可以编辑共享计划</option>
              </select>
            </label>
            <button
              className="primary"
              onClick={async () => {
                try {
                  const r = await post<{ token: string }>(
                    `/api/workspaces/${workspace.id}/invites`,
                    { role },
                  );
                  setToken(r.token);
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              创建一次性邀请码
            </button>
            {token && (
              <div className="invite-result">
                <label>
                  邀请码
                  <input
                    readOnly
                    value={token}
                    onFocus={(e) => e.target.select()}
                  />
                </label>
                <p className="subtle">
                  24 小时内有效，只能使用一次。同行者在同一 Wi-Fi
                  下打开应用，通过“加入旅行”填写邀请码。
                </p>
              </div>
            )}
            {invites.filter((i) => !i.used && i.expires > Date.now()).length >
              0 && (
              <div className="active-invites">
                <h3>尚未使用的邀请</h3>
                {invites
                  .filter((i) => !i.used && i.expires > Date.now())
                  .map((i) => (
                    <div className="section-line" key={i.id}>
                      <span className="subtle">
                        {roleName[i.role]} ·{" "}
                        {new Date(i.expires).toLocaleString("zh-CN")} 到期
                      </span>
                      <button
                        onClick={async () => {
                          try {
                            await api(
                              `/api/workspaces/${workspace.id}/invites/${i.id}`,
                              { method: "DELETE" },
                            );
                            setToken("");
                            await refresh();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        撤销邀请
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
        <ErrorNotice error={error} />
      </div>
    </Dialog>
  );
}
function SettingsDialog({
  user,
  onClose,
  onJoined,
  onLogout,
}: {
  user: User;
  onClose: () => void;
  onJoined: (id: string) => void;
  onLogout: () => Promise<void>;
}) {
  const [connection, setConnection] = useState<{
      shared: boolean;
      addresses: string[];
    } | null>(null),
    [token, setToken] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    api<typeof connection>("/api/connection")
      .then(setConnection)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <Dialog title="连接与备份" onClose={onClose}>
      <div className="dialog-body">
        <h3>同一 Wi-Fi 下使用</h3>
        {!connection ? (
          <p className="subtle">正在读取连接信息…</p>
        ) : connection.shared ? (
          <>
            <p className="subtle">
              手机浏览器打开以下地址，登录同一账号或使用邀请码加入。
            </p>
            {connection.addresses.map((address) => (
              <p key={address}>
                <a href={address}>{address}</a>
              </p>
            ))}
          </>
        ) : (
          <p className="subtle">
            当前仅本机可访问。请按启动说明启用局域网模式，手机即可连接。
          </p>
        )}
        <p className="subtle">
          电脑需保持开机并运行应用。第一版支持可信的局域网，不提供公网访问。
        </p>
        <form
          className="settings-section"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const result = await post<{ workspaceId: string }>("/api/join", {
                token,
              });
              onJoined(result.workspaceId);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <label>
            加入另一趟旅行
            <input
              value={token}
              required
              onChange={(e) => setToken(e.target.value.trim())}
              placeholder="填写一次性邀请码"
            />
          </label>
          <button>加入旅行</button>
        </form>
        {user.admin && (
          <section className="settings-section">
            <h3>备份本机数据</h3>
            <p className="subtle">
              包含本机所有成员与旅行资料，请妥善保存。恢复时先停止应用，再按使用说明操作。
            </p>
            <a className="button-link" href="/api/backup" download>
              下载完整备份
            </a>
          </section>
        )}
        <ErrorNotice error={error} />
        <button
          className="text-button settings-section"
          onClick={() => void onLogout().catch((e) => setError(e.message))}
        >
          <LogOut size={16} />
          退出 {user.name}
        </button>
      </div>
    </Dialog>
  );
}
