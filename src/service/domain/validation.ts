import { z } from "zod";
import { validateCards } from '../../shared/cards.js';
import { spatialSchema } from '../../shared/maps.js';
import { noteSchema } from '../../shared/notes.js';
import {
  nodeFields,
  type Dates,
  type WorkspaceData,
} from "../../shared/model.js";
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "INVALID",
  ) {
    super(message);
  }
}
export function ensure(
  condition: unknown,
  message: string,
  status = 400,
  code = 'INVALID',
): asserts condition {
  if (!condition) throw new AppError(status, message, code);
}
export function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number(value.slice(0, 4)) >= 1900 &&
    Number(value.slice(0, 4)) <= 2200 &&
    !Number.isNaN(Date.parse(value + "T12:00:00Z")) &&
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value
  );
}
export function validateDates(d: Dates) {
  if (d.mode === "fixed" || d.mode === "window") {
    ensure(
      validDate(d.start) && validDate(d.end),
      "请填写有效的起止日期（1900—2200 年）",
    );
    ensure(d.end >= d.start, "结束日期不能早于开始日期");
  }
  if (d.mode === "duration")
    ensure(
      d.minDays && d.maxDays && d.maxDays >= d.minDays,
      "请填写有效的最短与最长天数",
    );
  ensure(
    !d.startTime || /^([01]\d|2[0-3]):[0-5]\d$/.test(d.startTime),
    "开始时间无效",
  );
  ensure(
    !d.endTime || /^([01]\d|2[0-3]):[0-5]\d$/.test(d.endTime),
    "结束时间无效",
  );
  ensure(!d.endTime || d.startTime, "填写结束时间前请填写开始时间");
  ensure(
    !(d.startTime || d.endTime) || d.mode === "fixed",
    "具体时刻需要确定日期",
  );
  if (d.start === d.end && d.startTime && d.endTime)
    ensure(d.endTime > d.startTime, "同一天的结束时间应晚于开始时间");
  try {
    new Intl.DateTimeFormat("en", { timeZone: d.timezone }).format();
  } catch {
    throw new AppError(400, "时区无效");
  }
}
export const prepSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    note: z.string().max(4000).default(""),
    nodeIds: z.array(z.string().min(1)).min(1).max(500),
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            text: z.string().trim().min(1).max(600),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export function validateData(data: WorkspaceData) {
  ensure(
    data &&
      typeof data === "object" &&
      ["trip", "standalone"].includes(data.kind),
    "无效的计划数据",
  );
  const nodes = Object.values(data.nodes);
  ensure(nodes.length > 0 && nodes.length <= 3000, "计划为空或超过 3000 项");
  ensure(data.nodes[data.rootId]?.parentId === null, "根计划无效");
  ensure(
    nodes.filter((n) => n.parentId === null).length === 1,
    "每份计划只能有一个根节点",
  );
  for (const n of nodes) {
    ensure(n.id && data.nodes[n.id] === n, "计划标识无效");
    const { id, parentId, order, ...fields } = n;
    nodeFields.parse(fields);
    validateDates(n.dates);
    ensure(Number.isFinite(order), "排序无效");
    ensure(
      (n.location.lat === null) === (n.location.lng === null),
      "经纬度需要同时填写",
    );
    const seen = new Set<string>();
    let current: typeof n | undefined = n;
    while (current) {
      ensure(!seen.has(current.id), "计划不能放进自身或后代");
      seen.add(current.id);
      if (current.parentId === null) break;
      ensure(data.nodes[current.parentId], "找不到上级计划");
      current = data.nodes[current.parentId];
    }
    ensure(seen.has(data.rootId), "计划必须属于当前根节点");
  }
  const stepIds = new Set<string>();
  validateCards(data);
  if (data.notebook !== undefined) {
    ensure(data.notebook && typeof data.notebook === 'object' && !Array.isArray(data.notebook), '笔记数据无效');
    ensure(Object.keys(data.notebook).length <= 3000, '笔记超过 3000 篇');
    for (const [id, value] of Object.entries(data.notebook)) {
      const note = noteSchema.parse(value);
      ensure(note.id === id, '笔记标识无效');
      if (note.origin) ensure(note.origin.kind === 'preparation' ? data.preparations[note.origin.sourceId] : data.nodes[note.origin.sourceId], '笔记原始记录不存在');
      ensure(note.nodeIds.every(n => data.nodes[n]), '笔记关联的计划不存在');
      ensure(note.preparationIds.every(p => data.preparations[p]), '笔记引用的清单不存在');
    }
  }
  if (data.spatial !== undefined) {
    const spatial = spatialSchema.parse(data.spatial);
    for (const [nodeId, bindings] of Object.entries(spatial)) {
      ensure(data.nodes[nodeId], '空间关联节点不存在');
      ensure(new Set(bindings.map(b => b.assetId)).size === bindings.length && bindings.filter(b => b.primary).length <= 1, '空间引用重复或主地点不唯一');
      for (const b of bindings) {
        ensure(b.nodeIds.every(id => data.nodes[id]), '空间关联的计划不存在');
        ensure(b.mediaIds.every(id => data.media?.[nodeId]?.includes(id)), '空间配图没有关联到当前计划');
      }
    }
  }
  if (data.media !== undefined) {
    ensure(data.media && typeof data.media === 'object' && !Array.isArray(data.media), '图片关联无效');
    for (const [nodeId, ids] of Object.entries(data.media)) {
      ensure(data.nodes[nodeId] && Array.isArray(ids) && ids.length <= 30 && new Set(ids).size === ids.length && ids.every(id => z.string().uuid().safeParse(id).success), '图片关联的节点或标识无效');
    }
  }
  for (const [id, p] of Object.entries(data.preparations)) {
    ensure(p.id === id, "准备标识无效");
    const { id: _, ...rest } = p;
    prepSchema.parse(rest);
    ensure(
      new Set(p.nodeIds).size === p.nodeIds.length &&
        p.nodeIds.every((n) => data.nodes[n]),
      "准备关联无效或重复",
    );
    for (const step of p.steps) {
      ensure(!stepIds.has(step.id), "准备步骤标识重复");
      stepIds.add(step.id);
    }
  }
  ensure(
    data.progress &&
      typeof data.progress === "object" &&
      !Array.isArray(data.progress),
    "准备进度无效",
  );
  for (const steps of Object.values(data.progress))
    for (const [id, value] of Object.entries(steps))
      ensure(stepIds.has(id) && typeof value === "boolean", "个人进度引用无效");
}
