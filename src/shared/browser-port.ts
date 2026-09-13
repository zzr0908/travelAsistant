import type { BrowserStore } from '../storage/browser.js';
import type { BrowserOptions } from '../agent/browser/engine.js';
import type { BrowserResult } from './browser-model.js';
export type BrowserStorePort = Pick<BrowserStore, 'begin' | 'state' | 'finish' | 'get' | 'list' | 'artifact' | 'recover'>;
export interface BrowserApi {
  store: BrowserStore;
  status(): any;
  start(owner: string, raw: unknown, signal?: AbortSignal, lease?: string): {queryId: string; state: string};
  execute(owner: string, raw: unknown, signal?: AbortSignal, lease?: string): Promise<BrowserResult>;
  cancel(owner: string, id: string): any;
  releaseLease(lease: string): Promise<void>;
  disconnect(owner: string): Promise<void>;
  close(): Promise<void>;
}
export type { BrowserOptions };
