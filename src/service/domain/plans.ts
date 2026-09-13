import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "../../storage/database.js";
import {
  nodeFields,
  children,
  descendants,
  type Workspace,
  type WorkspaceData,
  type WorkspaceView,
  type WorkspaceSummary,
  type Role,
  type HistoryEntry,
} from "../../shared/model.js";
import { AppError, ensure, prepSchema, validateData } from "./validation.js";
import { addNode, editNode, moveNode, putPreparation, reorderNodes } from "./operations.js";
import { sampleData } from "./sample.js";
import { MapStore } from '../../maps/store.js';
import { spatialBindingSchema } from '../../shared/maps.js';
import { noteFields, workspaceMediaIds } from '../../shared/notes.js';
import { positionPlace } from '../../shared/place-insertion.js';
import { removePlan } from './remove-plan.js';
import { migrateNotes } from './note-migration.js';
import { saveCards, saveCardsPayload, mergeCards } from './cards.js';

const commandSchema = z
  .object({
    requestId: z.string().uuid(),
    kind: z.enum([
      "create",
      "sample",
      "edit",
      "add",
      "move",
      "reorder",
      "removePlan",
      "merge",
      "prep",
      "progress",
      "media",
      "spatial",
      "note",
      "deleteNote",
      "migrateNotes",
      "adoptPlace",
      "savePlaceNote",
      "undo",
      "cards",
    ]),
    workspaceId: z.string().optional(),
    version: z.number().int().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
type Snapshot = Record<string, Workspace | null>;
interface Change {
  id: string;
  user_id: string;
  label: string;
  before_data: string;
  after_versions: string;
  created: string;
  undone_by: string | null;
  request_body: string;
  result: string;
}

export class Plans {
  constructor(public db: DB) {}
  get(id: string, includeDeleted = false): Workspace {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(id) as
      | {
          id: string;
          owner_id: string;
          version: number;
          data: string;
          deleted: number;
        }
      | undefined;
    if (!row || (!includeDeleted && row.deleted))
      throw new AppError(404, "找不到这份计划");
    return {
      id: row.id,
      ownerId: row.owner_id,
      version: row.version,
      data: JSON.parse(row.data),
      deleted: !!row.deleted,
    };
  }
  role(id: string, userId: string): Role | undefined {
    return (
      this.db
        .prepare("SELECT role FROM members WHERE workspace_id=? AND user_id=?")
        .get(id, userId) as { role: Role } | undefined
    )?.role;
  }
  access(id: string, userId: string, edit = false, includeDeleted = false) {
    const role = this.role(id, userId);
    ensure(role, "没有这份计划的访问权限", 403);
    if (edit)
      ensure(role !== "reader", "当前为只读权限，无法修改共同计划", 403);
    return this.get(id, includeDeleted);
  }
  list(userId: string): WorkspaceSummary[] {
    const ids = this.db
      .prepare(
        "SELECT w.id,m.role FROM workspaces w JOIN members m ON w.id=m.workspace_id WHERE m.user_id=? AND w.deleted=0 ORDER BY w.rowid DESC",
      )
      .all(userId) as { id: string; role: Role }[];
    return ids.map(({ id, role }) => {
      const w = this.get(id),
        root = w.data.nodes[w.data.rootId];
      return {
        id,
        title: root.title,
        kind: w.data.kind,
        dates: root.dates,
        role,
        version: w.version,
        sample: w.data.sample,
        count: Object.keys(w.data.nodes).length,
      };
    });
  }
  history(id: string, userId: string): HistoryEntry[] {
    const rows = this.db
      .prepare(
        "SELECT c.*,u.name FROM changes c JOIN users u ON u.id=c.user_id WHERE EXISTS (SELECT 1 FROM json_each(c.after_versions) WHERE key=?) ORDER BY c.rowid DESC LIMIT 300",
      )
      .all(id) as (Change & { name: string })[];
    return rows
      .filter((row) =>
        Object.keys(JSON.parse(row.after_versions)).every((wid) =>
          this.role(wid, userId),
        ),
      )
      .slice(0, 30)
      .map((row) => {
        const versions = JSON.parse(row.after_versions) as Record<
          string,
          number
        >;
        const personal = JSON.parse(row.request_body).kind === "progress";
        return {
          id: row.id,
          label: row.label,
          actor: row.name,
          time: row.created,
          canUndo:
            row.user_id === userId &&
            !row.undone_by &&
            !row.label.startsWith("撤销：") &&
            Object.entries(versions).every(
              ([wid, v]) =>
                this.get(wid, true).version === v &&
                (personal || this.role(wid, userId) !== "reader"),
            ),
        };
      });
  }
  view(id: string, userId: string): WorkspaceView {
    const workspace = this.access(id, userId);
    const members = this.db
      .prepare(
        "SELECT u.id,u.name,m.role FROM members m JOIN users u ON m.user_id=u.id WHERE m.workspace_id=? ORDER BY m.rowid",
      )
      .all(id) as WorkspaceView["members"];
    return {
      ...workspace,
      role: this.role(id, userId)!,
      members,
      history: this.history(id, userId),
    };
  }
  authorizeMedia(data: WorkspaceData, userId: string, ids: string[]) {
    for (const id of ids) {
      if (workspaceMediaIds(data).includes(id)) continue;
      const asset = this.db.prepare('SELECT owner_id FROM media_assets WHERE id=?').get(id) as {owner_id: string} | undefined;
      ensure(asset?.owner_id === userId, '无权公开这张图片', 403);
      const scopes = this.db.prepare('SELECT r.scope FROM agent_runs r JOIN agent_run_media m ON m.run_id=r.id WHERE m.media_id=?').all(id) as {scope: string}[];
      ensure(scopes.some(r => { const scope = JSON.parse(r.scope); return !scope.workspaceId || this.role(scope.workspaceId, userId); }), '图片所属研究已不可访问', 403);
    }
  }
  save(w: Workspace) {
    validateData(w.data);
    new MapStore(this.db).validate(w.data);
    for (const id of workspaceMediaIds(w.data)) ensure(this.db.prepare("SELECT 1 FROM media_assets WHERE id=? AND bytes IS NOT NULL AND json_extract(metadata,'$.status')='ready'").get(id), '计划关联的图片未保存');
    this.db
      .prepare(
        "INSERT INTO workspaces(id,owner_id,version,data,deleted) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data,deleted=excluded.deleted",
      )
      .run(w.id, w.ownerId, w.version, JSON.stringify(w.data), +w.deleted);
  }
  execute(userId: string, input: unknown) {
    const command = commandSchema.parse(input),
      requestBody = JSON.stringify(command);
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM changes WHERE user_id=? AND request_id=?")
        .get(userId, command.requestId) as Change | undefined;
      if (existing) {
        ensure(
          existing.request_body === requestBody,
          "同一请求标识不能用于不同修改",
          409,
        );
        for (const id of Object.keys(JSON.parse(existing.after_versions)))
          this.access(id, userId, false, true);
        return JSON.parse(existing.result) as {
          workspaceId: string;
          changeId: string;
        };
      }
      const before: Snapshot = {},
        updated: Record<string, Workspace> = {};
      let label = "",
        resultId = "";
      let undoId: string | undefined;
      const touch = (id: string, edit = true, deleted = false) => {
        const w = this.access(id, userId, edit, deleted);
        before[id] = structuredClone(w);
        updated[id] = w;
        return w;
      };
      if (command.kind === "sample") {
        z.object({}).strict().parse(command.payload);
        const id = randomUUID();
        before[id] = null;
        updated[id] = {
          id,
          ownerId: userId,
          version: 0,
          deleted: false,
          data: sampleData(),
        };
        resultId = id;
        label = "载入意大利验收示例";
      } else if (command.kind === "create") {
        const payload = z
          .object({ kind: z.enum(["trip", "standalone"]), node: nodeFields })
          .strict()
          .parse(command.payload);
        const id = randomUUID(),
          rootId = randomUUID();
        const w: Workspace = {
          id,
          ownerId: userId,
          version: 0,
          deleted: false,
          data: {
            rootId,
            kind: payload.kind,
            nodes: {
              [rootId]: {
                ...payload.node,
                id: rootId,
                parentId: null,
                order: 0,
              },
            },
            preparations: {},
            progress: {},
            sample: false,
          },
        };
        before[id] = null;
        updated[id] = w;
        resultId = id;
        label = `创建${payload.kind === "trip" ? "旅行" : "独立计划"}：${payload.node.title}`;
      } else if (command.kind === "undo") {
        const { changeId } = z
          .object({ changeId: z.string().uuid() })
          .strict()
          .parse(command.payload);
        const original = this.db
          .prepare("SELECT * FROM changes WHERE id=?")
          .get(changeId) as Change | undefined;
        ensure(
          original &&
            original.user_id === userId &&
            !original.undone_by &&
            !original.label.startsWith("撤销："),
          "这笔修改不能撤销",
          409,
        );
        const originalBefore = JSON.parse(original.before_data) as Snapshot,
          versions = JSON.parse(original.after_versions) as Record<
            string,
            number
          >;
        for (const [id, version] of Object.entries(versions)) {
          const current = touch(
            id,
            JSON.parse(original.request_body).kind !== "progress",
            true,
          );
          ensure(
            current.version === version,
            "此后已有修改，不能用旧内容覆盖。请查看最新记录后手动调整。",
            409,
          );
          const old = originalBefore[id];
          updated[id] = old
            ? { ...old, version: current.version }
            : { ...current, deleted: true };
        }
        resultId =
          Object.values(updated).find((w) => !w.deleted)?.id ||
          Object.keys(updated)[0];
        label = `撤销：${original.label}`;
        undoId = changeId;
      } else {
        ensure(command.workspaceId, "未指定计划");
        const w = touch(command.workspaceId, command.kind !== "progress");
        ensure(
          w.version === command.version,
          "计划已有更新。你的输入已保留，请对照最新内容后重新保存。",
          409,
        );
        resultId = w.id;
        const data = w.data;
        if (command.kind === 'cards') {
          const payload=saveCardsPayload.parse(command.payload);
          if(payload.draftId) {
            const draft=this.db.prepare('SELECT * FROM card_drafts WHERE id=? AND owner_id=? AND workspace_id=?').get(payload.draftId,userId,w.id) as {state:string;expires:number;body:string}|undefined;
            ensure(draft&&draft.state==='ready'&&draft.expires>Date.now(),'导入草稿不可用或已过期',409);
          }
          const cards=saveCards(data,payload);
          if(payload.draftId)this.db.prepare("UPDATE card_drafts SET state='saved',body='{}' WHERE id=?").run(payload.draftId);
          label=`保存关键卡片：${cards.map(c=>c.title).join('、')}`;
        } else if (command.kind === 'savePlaceNote') {
          const p = z.object({assetId:z.string().uuid()}).strict().parse(command.payload);
          const asset = new MapStore(this.db).allowed(p.assetId,userId,w.id);
          ensure(!Object.values(data.notebook || {}).some(note=>note.spatialIds?.includes(asset.id)), '这处地点或路线已有笔记，可在笔记模块查看');
          const id=randomUUID(),now=new Date().toISOString();
          data.notebook ||= {};
          data.notebook[id] = {id,title:asset.name.slice(0,160),body:`${asset.address}\n\n[地图来源](${asset.source.url})\n\n看点与具体指引待补充。`,nodeIds:[],mediaIds:[],preparationIds:[],spatialIds:[asset.id],createdAt:now,updatedAt:now};
          label=`保存地点资料为笔记：${asset.name}`;
        } else if (command.kind === 'adoptPlace') {
          const p = z.object({parentId:z.string(), assetId:z.string().uuid(), beforeNodeId:z.string().optional()}).strict().parse(command.payload);
          ensure(data.nodes[p.parentId], '找不到加入安排的上级计划');
          const maps = new MapStore(this.db), asset = maps.allowed(p.assetId, userId, w.id);
          ensure(asset.kind === 'place' && asset.geometry.type === 'Point', '请选择有效地点');
          const planned = descendants(data, p.parentId).flatMap(n => (data.spatial?.[n.id] || []).filter(b => b.primary));
          ensure(!planned.some(b => maps.allowed(b.assetId,userId,w.id).entityId === asset.entityId), '这个地点已在当前安排中');
          const id = randomUUID();
          addNode(data,id,p.parentId,nodeFields.parse({title:asset.name,kind:'activity',location:{name:asset.name,address:asset.address,lat:asset.geometry.coordinates[1],lng:asset.geometry.coordinates[0]}}));
          positionPlace(data,p.parentId,id,p.beforeNodeId);
          maps.bind(data,userId,w.id,id,[spatialBindingSchema.parse({assetId:asset.id,primary:true})]);
          label = `加入地点：${asset.name}`;
        } else if (command.kind === 'migrateNotes') {
          z.object({}).strict().parse(command.payload);
          label = `整理旧资料为笔记：${migrateNotes(data, w.id)} 篇`;
        } else if (command.kind === 'note') {
          const p = z.object({ noteId: z.string().uuid().optional(), note: noteFields }).strict().parse(command.payload);
          const old = p.noteId ? data.notebook?.[p.noteId] : undefined;
          if (p.noteId) ensure(old, '找不到这篇笔记');
          const id = p.noteId || randomUUID(), now = new Date().toISOString();
          this.authorizeMedia(data, userId, p.note.mediaIds);
          for (const assetId of p.note.spatialIds || []) new MapStore(this.db).allowed(assetId,userId,w.id);
          data.notebook ||= {};
          data.notebook[id] = { ...p.note, id, createdAt: old?.createdAt || now, updatedAt: now, ...(old?.origin ? {origin:old.origin} : {}) };
          if (old?.origin?.kind === 'description' || old?.origin?.kind === 'notes') {
            data.nodes[old.origin.sourceId][old.origin.kind] = p.note.body;
          }
          label = `${old ? '编辑' : '添加'}笔记：${p.note.title}`;
        } else if (command.kind === 'deleteNote') {
          const p = z.object({ noteId: z.string().uuid() }).strict().parse(command.payload);
          const note = data.notebook?.[p.noteId];
          ensure(note, '找不到这篇笔记');
          label = `删除笔记：${note.title}`;
          delete data.notebook![p.noteId];
        } else if (command.kind === 'spatial') {
          const p = z.object({ nodeId: z.string(), bindings: z.array(spatialBindingSchema).max(50) }).strict().parse(command.payload);
          new MapStore(this.db).bind(data, userId, w.id, p.nodeId, p.bindings);
          label = `修改地图内容：${data.nodes[p.nodeId].title}`;
        } else if (command.kind === "media") {
          const p = z.object({ nodeId: z.string(), mediaIds: z.array(z.string().uuid()).max(30) }).strict().parse(command.payload);
          ensure(data.nodes[p.nodeId], '图片关联节点不存在');
          this.authorizeMedia(data, userId, p.mediaIds);
          data.media ||= {}; data.media[p.nodeId] = [...new Set(p.mediaIds)];
          for (const b of data.spatial?.[p.nodeId] || []) b.mediaIds = b.mediaIds.filter(id => p.mediaIds.includes(id));
          label = `修改配图：${data.nodes[p.nodeId].title}`;
        } else if (command.kind === "add") {
          const p = z
            .object({ parentId: z.string(), node: nodeFields })
            .strict()
            .parse(command.payload);
          ensure(data.nodes[p.parentId], "找不到上级计划");
          const id = randomUUID();
          addNode(data, id, p.parentId, p.node);
          label = `添加：${p.node.title}`;
        } else if (command.kind === "edit") {
          const p = z
            .object({
              nodeId: z.string(),
              node: nodeFields,
              confirmFixed: z.boolean().default(false),
            })
            .strict()
            .parse(command.payload);
          editNode(data, p.nodeId, p.node, p.confirmFixed);
          label = `编辑：${p.node.title}`;
        } else if (command.kind === 'removePlan') {
          const p=z.object({nodeId:z.string(),confirmFixed:z.boolean().optional()}).strict().parse(command.payload);
          const title=data.nodes[p.nodeId]?.title;
          removePlan(data,p.nodeId,p.confirmFixed);
          label=`移出行程并保留资料：${title}`;
        } else if (command.kind === 'reorder') {
          const p = z.object({parentId:z.string(),nodeIds:z.array(z.string()).max(3000)}).strict().parse(command.payload);
          reorderNodes(data,p.parentId,p.nodeIds);
          label = `调整顺序：${data.nodes[p.parentId].title}`;
        } else if (command.kind === "move") {
          const p = z
            .object({ nodeId: z.string(), parentId: z.string() })
            .strict()
            .parse(command.payload);
          moveNode(data, p.nodeId, p.parentId);
          label = `移动：${data.nodes[p.nodeId].title}`;
        } else if (command.kind === "merge") {
          const p = z
            .object({
              targetId: z.string(),
              targetVersion: z.number().int(),
              parentId: z.string(),
            })
            .strict()
            .parse(command.payload);
          ensure(
            w.data.kind === "standalone" && w.ownerId === userId,
            "仅独立计划的所有者可以归并",
          );
          ensure(w.id !== p.targetId, "不能归并到自身");
          const target = touch(p.targetId);
          ensure(
            target.version === p.targetVersion,
            "目标旅行已有更新，请重新检查归并内容",
            409,
          );
          ensure(
            target.data.kind === "trip" && target.data.nodes[p.parentId],
            "归并目标必须是旅行中的计划",
          );
          for (const n of Object.values(data.nodes))
            ensure(!target.data.nodes[n.id], "目标中已有相同记录");
          data.nodes[data.rootId].parentId = p.parentId;
          data.nodes[data.rootId].order =
            Math.max(
              -1,
              ...children(target.data, p.parentId).map((n) => n.order),
            ) + 1;
          target.data.media = { ...target.data.media, ...data.media };
          mergeCards(data,target.data);
          for (const id of Object.keys(data.notebook || {})) ensure(!target.data.notebook?.[id], '目标中已有相同笔记');
          target.data.notebook = { ...target.data.notebook, ...data.notebook };
          target.data.spatial = { ...target.data.spatial, ...data.spatial };
          Object.assign(target.data.nodes, data.nodes);
          Object.assign(target.data.preparations, data.preparations);
          for (const [uid, steps] of Object.entries(data.progress))
            target.data.progress[uid] = {
              ...target.data.progress[uid],
              ...steps,
            };
          // The archived source keeps its original standalone graph; the target receives the same identifiers.
          w.data = structuredClone(before[w.id]!.data);
          w.deleted = true;
          resultId = target.id;
          label = `归并：${data.nodes[data.rootId].title}`;
        } else if (command.kind === "prep") {
          const p = z
            .object({ prepId: z.string().optional(), preparation: prepSchema })
            .strict()
            .parse(command.payload);
          const id = p.prepId || randomUUID();
          if (p.prepId) ensure(data.preparations[id], "找不到准备事项");
          putPreparation(data, { ...p.preparation, id });
          label = `准备事项：${p.preparation.title}`;
        } else if (command.kind === "progress") {
          const p = z
            .object({ stepId: z.string(), done: z.boolean() })
            .strict()
            .parse(command.payload);
          ensure(
            Object.values(data.preparations).some((prep) =>
              prep.steps.some((s) => s.id === p.stepId),
            ),
            "找不到准备步骤",
          );
          data.progress[userId] ??= {};
          data.progress[userId][p.stepId] = p.done;
          label = p.done ? "完成一项个人准备" : "取消一项个人准备";
        }
      }
      const afterVersions: Record<string, number> = {};
      for (const w of Object.values(updated)) {
        w.version++;
        this.save(w);
        afterVersions[w.id] = w.version;
        if (before[w.id] === null)
          this.db
            .prepare(
              "INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)",
            )
            .run(w.id, userId, "owner");
      }
      const changeId = randomUUID(),
        result = { workspaceId: resultId, changeId };
      this.db
        .prepare(
          "INSERT INTO changes(id,user_id,request_id,request_body,label,before_data,after_versions,result,created) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          changeId,
          userId,
          command.requestId,
          requestBody,
          label,
          JSON.stringify(before),
          JSON.stringify(afterVersions),
          JSON.stringify(result),
          new Date().toISOString(),
        );
      if (undoId)
        this.db
          .prepare("UPDATE changes SET undone_by=? WHERE id=?")
          .run(changeId, undoId);
      return result;
    })();
  }
}
