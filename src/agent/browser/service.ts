import type { DB } from '../../storage/database.js';
import { BrowserStore } from '../../storage/browser.js';
import { BrowserEngine, type BrowserOptions } from './engine.js';
export * from './engine.js';
/** Local diagnostic/test adapter. Production browser execution lives in the worker. */
export class BrowserService extends BrowserEngine {
  declare readonly store: BrowserStore;
  constructor(db: DB, options: BrowserOptions) { super(new BrowserStore(db), options); }
}
