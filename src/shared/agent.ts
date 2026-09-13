import { z } from "zod";
import { nodeFields, dateSchema, type PlanNode, type Preparation } from "./model.js";
import { spatialBindingSchema, spatialReferenceSchema, spatialEvidenceSchema, type SpatialBinding, type SpatialSummary, type SpatialPresentation } from './maps.js';

const ref = z.string().min(1).max(100);
const dateChanges=z.object({
  mode:dateSchema.shape.mode.removeDefault().optional(),start:dateSchema.shape.start.removeDefault().optional(),end:dateSchema.shape.end.removeDefault().optional(),
  startTime:dateSchema.shape.startTime.removeDefault().optional(),endTime:dateSchema.shape.endTime.removeDefault().optional(),timezone:dateSchema.shape.timezone.removeDefault().optional(),
  minDays:dateSchema.shape.minDays.removeDefault().optional(),maxDays:dateSchema.shape.maxDays.removeDefault().optional(),
}).strict();
// Strip creation defaults before making a patch optional: omitted fields must stay unchanged.
const nodeChanges = z.object({
  title: nodeFields.shape.title.optional(),
  description: nodeFields.shape.description.removeDefault().optional().describe("安排说明／简介，对应页面主要介绍文字；不是备注。"),
  notes: nodeFields.shape.notes.removeDefault().optional().describe("备注，位于编辑表单的偏好与备注区域；用户明确修改备注时使用此字段，保留description安排说明。"),
  preference: nodeFields.shape.preference.removeDefault().optional(),
  kind: nodeFields.shape.kind.removeDefault().optional(),
  dates: dateChanges.optional().describe('日期局部修改；未提供的日期、时间、时区保持原值。'),
  fixed: nodeFields.shape.fixed.removeDefault().optional(),
  location: nodeFields.shape.location.removeDefault().partial().optional(),
}).strict();
export const agentOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal('set_spatial'), nodeId: ref, bindings: z.array(spatialBindingSchema.omit({ dependency: true })).max(50) }).strict().describe('设置节点完整地图关联。先创建节点并关联图片，再用地图工具返回的 assetId；primary=true 由服务投影地点，禁止在 node.location 写坐标。路径 nodeIds 按停留顺序列出已创建的节点。空数组解除地图关联。'),
  z.object({ kind: z.literal('set_media'), nodeId: ref, mediaIds: z.array(z.string().uuid()).max(30) }).strict().describe('设置节点完整配图列表。只能引用 read_travel_source 返回的 ready mediaId；空数组表示解除关联，不改变日期或固定安排。'),
  z.object({ kind: z.literal("new_workspace"), id: ref, workspaceKind: z.enum(["trip", "standalone"]).default("standalone"), node: nodeFields }).strict(),
  z.object({ kind: z.literal("add_node"), id: ref, parentId: ref, node: nodeFields }).strict(),
  z.object({ kind: z.literal("update_node"), nodeId: ref, changes: nodeChanges }).strict(),
  z.object({ kind: z.literal("move_node"), nodeId: ref, parentId: ref }).strict(),
  z.object({ kind: z.literal("reorder_children"), parentId: ref, nodeIds: z.array(ref).min(1).max(200) }).strict(),
  z.object({ kind: z.literal("preparation"), id: ref, title: z.string().min(1).max(160), note: z.string().max(4000).default(""), nodeIds: z.array(ref).min(1).max(100), steps: z.array(z.object({ id: ref, text: z.string().min(1).max(600) }).strict()).min(1).max(100) }).strict().describe("新建或复用准备。id为已有清单ID时，nodeIds表示要追加关联的本范围节点，服务保留原关联；可用此操作将跨范围共用清单关联到当前日计划。仅关联时原样传入title、note及全部旧steps和ID。范围外共用内容不得改变，已有步骤不得删除或改名。新建清单则使用新占位id。"),
]);
export type AgentOperation = z.infer<typeof agentOperation>;
export const claimSchema = z.object({
  id: ref,
  text: z.string().min(1).max(1500),
  status: z.enum(["source_supported", "user_provided", "suggestion", "unknown", "conflict"]),
  queryId: z.string().uuid().optional(),
  quote: z.string().min(8).max(1200).optional(),
  spatialEvidence: spatialEvidenceSchema.optional().describe('结构化地图字段证据，不能同时使用网页 queryId/quote。主张文字由服务按此字段生成；不能据此断言营业、票价或体验。'),
  appliesTo: z.string().max(500).default(""),
  dynamic: z.boolean().default(false),
  nodeIds: z.array(ref).max(100).default([]),
}).strict();
export const agentOutput = z.object({
  answer: z.string().min(1).max(16000),
  candidates: z.array(z.object({ id: ref, title: z.string().min(1).max(160), description: z.string().min(1).max(2000), tradeoffs: z.string().min(1).max(1500) }).strict()).max(3).default([]),
  question: z.object({ text: z.string().min(1).max(1000), options: z.array(z.string().min(1).max(300)).max(5).default([]), required: z.boolean().default(true) }).strict().optional(),
  proposal: z.object({ title: z.string().min(1).max(160), operations: z.array(agentOperation).min(1).max(100), assumptions: z.array(z.string().max(1000)).max(30).default([]) }).strict().optional(),
  claims: z.array(claimSchema).max(40).default([]),
  media: z.array(z.object({ mediaId: z.string().uuid(), candidateId: ref.optional() }).strict()).max(30).default([]).describe('引用采集返回的 ready mediaId；candidateId 将图片关联到对应候选，省略则作为回答配图。配图不代表已理解图中文字。'),
  spatial: z.array(spatialReferenceSchema).max(100).default([]).describe('回答和候选的地图引用，只用工具返回或上下文内的 assetId。candidateId 关联候选；nodeId 关联安排；mediaIds 关联对应配图。查看不写入计划，采用需另用 set_spatial。'),
}).strict();
export type AgentOutput = z.infer<typeof agentOutput>;
export type AgentClaim = z.infer<typeof claimSchema> & { url?: string; retrievedAt?: string; textHash?: string; limitations?: string[] };
export type RunState = "queued" | "running" | "needs_input" | "completed" | "partial" | "cancelling" | "cancelled" | "failed" | "interrupted";
export interface AgentScope { workspaceId: string | null; nodeId: string | null }
export interface AgentCapability { available: boolean; model: string; message: string; mode: "ordinary" | "development" | "disabled" }
export interface AgentUsage { modelRequests: number; browserQueries: number; mapQueries?: number; mapEstimatedCredits?: number | null; tokens: number | null; inputTokens: number | null; outputTokens: number | null; cacheTokens: number | null; cost: null; responseModels: string[] }
export interface MediaRecord { id: string; title: string; mediaIds: string[] }
export interface SpatialRecord { id: string; title: string; bindings: SpatialBinding[] }
export interface AgentDiff { kind: string; id: string; before: PlanNode | Preparation | MediaRecord | SpatialRecord | null; after: PlanNode | Preparation | MediaRecord | SpatialRecord | null }
export interface ProposalView {
  id: string; revision: number; digest: string; baseVersion: number | null; title: string;
  status: "ready" | "applied" | "rejected" | "stale" | "undone";
  workspaceId: string; changeId: string | null; diffs: AgentDiff[]; assumptions: string[];
  claims: AgentClaim[]; canApply: boolean; shared: boolean; warning: string | null;
  spatialBefore?: SpatialPresentation[]; spatialAfter?: SpatialPresentation[];
}
export interface AgentRunView {
  id: string; sessionId: string; scope: AgentScope; scopeLabel: string; prompt: string;
  state: RunState; message: string; createdAt: string; updatedAt: string; usage: AgentUsage;
  trajectoryRevision: string;
  output: (Omit<AgentOutput, "proposal" | "claims" | "spatial"> & { claims: AgentClaim[]; spatial: SpatialPresentation[] }) | null;
  proposal: ProposalView | null; questionAnswered: boolean; parentRunId: string | null;
  media: MediaAsset[];
  spatial?: SpatialSummary[];
  researchPlaceIds?: string[];
}
export interface AgentSessionView { id: string; scope: AgentScope; title: string; updatedAt: string }
export interface AgentEvent { seq: number; type: string; data: unknown; createdAt: string }
export interface PublishedClaim extends Omit<AgentClaim, "status"> { publishedId: string; status: AgentClaim["status"] | "conditions_changed" }
export interface MediaAsset {
  accessWorkspaceId?: string;
  duplicateOf?: string;
  id: string; kind: 'image' | 'screenshot'; status: 'ready' | 'failed' | 'excluded' | 'reference_only';
  url: string; sourceUrl: string; sourceTitle: string; alt: string; caption: string; retrievedAt: string;
  width: number | null; height: number | null; mimeType: string | null; sha256: string | null;
  message: string; interpretation: 'not_performed'; license: string | null;
}
