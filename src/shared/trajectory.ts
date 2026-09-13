export interface TraceItem {
  id: string; origin: 'harness' | 'application' | 'change'; seq: number | null;
  type: string; title: string; time: string; step: number | null; turn: number | null;
  status: 'info' | 'running' | 'success' | 'warning' | 'error'; summary: string;
  callId: string | null; durationMs: number | null; detailBytes: number; internal: boolean;
}
export interface TracePage {
  items: TraceItem[]; total: number; matching: number; nextOffset: number | null;
  counts: { harness: number; application: number; changes: number; errors: number; queries: number; pages: number; failedQueries: number; mapQueries?: number; claims: number; media: number };
  gaps: string[]; durationMs: number; hasRequestSnapshot: boolean;
}
