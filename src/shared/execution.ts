import type { CardExtractor } from '../cards/import.js';
export interface StrategyInput {
  context: { base: import('./model.js').Workspace | null; projection: unknown; previousRuns: unknown[]; selectedCandidate?: unknown; researchPlaces?: unknown[]; scopeLabel: string };
  prompt: string; browserQueries: number; mapMessage: string; repair?: boolean;
}
export interface AgentLimits { modelRequests: number; browserQueries: number; runMs: number; queueMs: number; concurrency: number; queueSize: number; outputTokens: number; tokenThreshold: number }
export const defaultLimits: AgentLimits = { modelRequests: 12, browserQueries: 10, runMs: 180000, queueMs: 60000, concurrency: 2, queueSize: 4, outputTokens: 4096, tokenThreshold: 150000 };
export interface TravelTool { name: string; description: string; parameters: Record<string, unknown>; execute(input: unknown, signal: AbortSignal): Promise<unknown> }
export interface DriverInput { strategy?: StrategyInput; id: string; prompt: string; tools: TravelTool[]; signal: AbortSignal; maxTokens: number; beforeModel(estimatedInputTokens: number): void | Promise<void>; usage(value: { model: string; input?: number; output?: number; cache?: number; total?: number }): void | Promise<void>; text(value: string): void; hasResult(): boolean; request?(value: unknown): void | Promise<void> }
export interface AgentDriver { extractCards?: CardExtractor; kind: 'harness' | 'test' | 'remote'; available?(): boolean; status?(): { available: boolean; message: string }; run(input: DriverInput): Promise<void>; release?(id: string): Promise<void>; close(): Promise<void> }

export const EXECUTION_PROTOCOL = 1;
export type ExecutionKind = 'research' | 'browser' | 'image' | 'release';
export interface ExecutionTask { id: string; kind: ExecutionKind; payload: any; lease: string; deadline: number; }
