import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { X, LockKeyhole, AlertTriangle } from "lucide-react";
import {
  nodeFields,
  type NodeFields,
  type WorkspaceView,
  type Preparation,
  trail,
} from "../../shared/model";
import { ApiError, uid } from "./api";
import { coordinateContextWarning } from '../../shared/maps';

export function Dialog({
  title,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog
      ?.querySelector<HTMLInputElement>(
        "input:not([type=checkbox]),textarea,select",
      )
      ?.focus();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="关闭对话框"
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <div role="alert" className="alert error">
      <AlertTriangle size={18} />
      <span>{error}</span>
    </div>
  ) : null;
}
export function NodeForm({
  initial,
  title,
  onClose,
  onSave,
  context,
  locationReferences = [],
  onRebase,
}: {
  initial?: NodeFields;
  title: string;
  onClose: () => void;
  onSave: (n: NodeFields, confirm: boolean) => Promise<void>;
  context?: string;
  locationReferences?: NodeFields['location'][];
  onRebase?: () => Promise<string>;
}) {
  const [form, setForm] = useState<NodeFields>(() =>
    structuredClone(initial || nodeFields.parse({ title: "新计划" })),
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false),
    [latest, setLatest] = useState(""),
    [confirm, setConfirm] = useState(false);
  const update = <K extends keyof NodeFields>(key: K, value: NodeFields[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const date = (key: string, value: unknown) =>
    setForm((f) => ({ ...f, dates: { ...f.dates, [key]: value } }));
  const locationWarning = coordinateContextWarning(form.location, locationReferences.length ? locationReferences : initial ? [initial.location] : []);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(form, confirm);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose} busy={busy}>
      <form onSubmit={save} className="editor-form">
        <div className="dialog-body">
          {context && <p className="form-context">{context}</p>}
          <label>
            计划名称
            <input
              autoFocus
              required
              maxLength={160}
              value={form.title}
              onChange={(e) => update("title", e.target.value)}
            />
          </label>
          <div className="form-grid">
            <label>
              内容类型
              <select
                value={form.kind}
                onChange={(e) =>
                  update("kind", e.target.value as NodeFields["kind"])
                }
              >
                <option value="plan">计划</option>
                <option value="activity">具体活动</option>
                <option value="free">自由时间</option>
              </select>
            </label>
            <label>
              日期安排
              <select
                value={form.dates.mode}
                onChange={(e) =>
                  update("dates", {
                    ...form.dates,
                    mode: e.target.value as NodeFields["dates"]["mode"],
                    startTime: "",
                    endTime: "",
                  })
                }
              >
                <option value="unset">日期未定</option>
                <option value="fixed">确定日期</option>
                <option value="window">可选日期范围</option>
                <option value="duration">只确定天数范围</option>
              </select>
            </label>
          </div>
          {["fixed", "window"].includes(form.dates.mode) && (
            <div className="form-grid">
              <label>
                开始日期
                <input
                  type="date"
                  min="1900-01-01"
                  max="2200-12-31"
                  required
                  value={form.dates.start}
                  onChange={(e) => date("start", e.target.value)}
                />
              </label>
              <label>
                结束日期
                <input
                  type="date"
                  min="1900-01-01"
                  max="2200-12-31"
                  required
                  value={form.dates.end}
                  onChange={(e) => date("end", e.target.value)}
                />
              </label>
            </div>
          )}
          {form.dates.mode === "duration" && (
            <div className="form-grid">
              <label>
                最短天数
                <input
                  type="number"
                  required
                  min={1}
                  max={366}
                  value={form.dates.minDays ?? ""}
                  onChange={(e) =>
                    date(
                      "minDays",
                      e.target.value ? Number(e.target.value) : null,
                    )
                  }
                />
              </label>
              <label>
                最长天数
                <input
                  type="number"
                  required
                  min={form.dates.minDays || 1}
                  max={366}
                  value={form.dates.maxDays ?? ""}
                  onChange={(e) =>
                    date(
                      "maxDays",
                      e.target.value ? Number(e.target.value) : null,
                    )
                  }
                />
              </label>
            </div>
          )}
          {form.dates.mode === "fixed" && (
            <details>
              <summary>具体时刻与时区（可选）</summary>
              <div className="form-grid">
                <label>
                  开始时间
                  <input
                    type="time"
                    value={form.dates.startTime}
                    onChange={(e) => date("startTime", e.target.value)}
                  />
                </label>
                <label>
                  结束时间
                  <input
                    type="time"
                    value={form.dates.endTime}
                    onChange={(e) => date("endTime", e.target.value)}
                  />
                </label>
              </div>
              <label>
                当地时区
                <input
                  value={form.dates.timezone}
                  onChange={(e) => date("timezone", e.target.value)}
                  list="timezones"
                />
                <datalist id="timezones">
                  <option>Europe/Rome</option>
                  <option>Asia/Shanghai</option>
                  <option>Asia/Tokyo</option>
                  <option>America/Mexico_City</option>
                  <option>America/New_York</option>
                </datalist>
              </label>
            </details>
          )}
          <label>
            安排说明
            <textarea
              rows={3}
              maxLength={4000}
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              placeholder="想做什么，有哪些还没确定？"
            />
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={form.fixed}
              onChange={(e) => update("fixed", e.target.checked)}
            />
            <LockKeyhole size={16} />
            固定安排，需要明确确认才能调整日期
          </label>
          {initial?.fixed && (
            <label className="check-line warning">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              我已检查修改影响；这里只更新计划，不代表更改实际预订。
            </label>
          )}
          <details open={!!form.notes || !!form.preference}>
            <summary>偏好与备注</summary>
            <label>
              偏好
              <input
                maxLength={2000}
                value={form.preference}
                onChange={(e) => update("preference", e.target.value)}
                placeholder="例如：轻松一点，给散步留时间"
              />
            </label>
            <label>
              备注
              <textarea
                rows={4}
                maxLength={20000}
                value={form.notes}
                onChange={(e) => update("notes", e.target.value)}
              />
            </label>
          </details>
          <details open={!!form.location.name || !!form.location.address}>
            <summary>地点信息（手动录入）</summary>
            <label>
              地点名称
              <input
                maxLength={250}
                value={form.location.name}
                onChange={(e) =>
                  update("location", { ...form.location, name: e.target.value })
                }
              />
            </label>
            <label>
              地址
              <input
                maxLength={600}
                value={form.location.address}
                onChange={(e) =>
                  update("location", {
                    ...form.location,
                    address: e.target.value,
                  })
                }
              />
            </label>
            <div className="form-grid">
              <label>
                纬度（可选）
                <input
                  type="number"
                  min={-90}
                  max={90}
                  step="any"
                  value={form.location.lat ?? ""}
                  onChange={(e) =>
                    update("location", {
                      ...form.location,
                      lat: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </label>
              <label>
                经度（可选）
                <input
                  type="number"
                  min={-180}
                  max={180}
                  step="any"
                  value={form.location.lng ?? ""}
                  onChange={(e) =>
                    update("location", {
                      ...form.location,
                      lng: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </label>
            </div>
            <p className="subtle">经纬度同时填写；未填写的位置保持待补充。</p>
            {locationWarning && <p className="alert warning" role="status">{locationWarning}</p>}
          </details>
          <ErrorNotice error={error} />
          {conflict && onRebase && (
            <div className="conflict-review">
              <p className="subtle">
                先查看服务器上的最新内容，你的输入会保留。
              </p>
              <button
                type="button"
                onClick={async () => {
                  try {
                    setLatest(await onRebase());
                    setConflict(false);
                    setError("");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                查看最新版本并重新核对
              </button>
              {latest && <p>{latest}</p>}
            </div>
          )}
          {latest && !conflict && (
            <LatestSaved content={latest} />
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || conflict} type="submit">
            {busy ? "正在保存…" : "保存计划"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function PreparationForm({
  workspace,
  nodeId,
  initial,
  onSave,
  onClose,
  onRebase,
}: {
  workspace: WorkspaceView;
  nodeId: string;
  initial?: Preparation;
  onSave: (p: Omit<Preparation, "id">) => Promise<void>;
  onClose: () => void;
  onRebase: () => Promise<string>;
}) {
  const stepIds = useRef(new Map<string, string>());
  const [title, setTitle] = useState(initial?.title || ""),
    [note, setNote] = useState(initial?.note || ""),
    [steps, setSteps] = useState(
      initial?.steps.map((s) => s.text).join("\n") || "",
    ),
    [nodeIds, setNodeIds] = useState(initial?.nodeIds || [nodeId]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false),
    [latest, setLatest] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const used = new Set<string>();
      await onSave({
        title,
        note,
        nodeIds,
        steps: steps
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((text, index) => {
            const existing =
              initial?.steps.find((s) => s.text === text && !used.has(s.id)) ||
              (initial?.steps[index] && !used.has(initial.steps[index].id)
                ? initial.steps[index]
                : undefined);
            const key = `${index}:${text}`;
            const id = existing?.id || stepIds.current.get(key) || uid();
            stepIds.current.set(key, id);
            used.add(id);
            return { id, text };
          }),
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={initial ? "编辑准备事项" : "添加准备事项"} onClose={onClose} busy={busy}>
      <form onSubmit={save}>
        <div className="dialog-body">
          <label>
            准备事项名称
            <input
              autoFocus
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            准备步骤，每行一项
            <textarea
              rows={5}
              required
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              placeholder={"核对预约时间\n记录需要准备的材料"}
            />
          </label>
          <label>
            说明与待核实信息
            <textarea
              rows={2}
              maxLength={4000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <fieldset>
            <legend>用于哪些计划</legend>
            <div className="association-list">
              {Object.values(workspace.data.nodes).map((n) => (
                <label className="check-line" key={n.id}>
                  <input
                    type="checkbox"
                    checked={nodeIds.includes(n.id)}
                    onChange={(e) =>
                      setNodeIds(
                        e.target.checked
                          ? [...nodeIds, n.id]
                          : nodeIds.filter((id) => id !== n.id),
                      )
                    }
                  />
                  {trail(workspace.data, n.id)
                    .map((p) => p.title)
                    .join(" › ")}
                </label>
              ))}
            </div>
          </fieldset>
          <ErrorNotice error={error} />
          {conflict && (
            <button
              type="button"
              onClick={async () => {
                try {
                  setLatest(await onRebase());
                  setConflict(false);
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              保留输入并查看最新准备内容
            </button>
          )}
          {latest && (
            <LatestSaved content={latest} />
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || conflict || !nodeIds.length}
          >
            {busy ? "正在保存…" : "保存准备事项"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function LatestSaved({content}:{content:string}) {
  return <section className="latest-saved" aria-label="最新已保存内容">
    <h3>最新已保存的内容</h3>
    <p className="subtle">你的输入仍保留在上方，请逐项核对后再保存。</p>
    <pre>{content}</pre>
  </section>;
}
