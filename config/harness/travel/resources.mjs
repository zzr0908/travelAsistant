import { resolve } from 'node:path';
import { root } from './modules.mjs';
import { openDatabase } from '../../../dist/server/storage/database.js';
import { acquireLock } from '../../../dist/server/storage/runtime-lock.js';
import { Plans } from '../../../dist/server/service/domain/plans.js';
import { Auth } from '../../../dist/server/service/server/auth.js';
import { BrowserService } from '../../../dist/server/agent/browser/service.js';
import { browserOptions } from '../../../dist/server/agent/browser/config.js';
import { MapService } from '../../../dist/server/maps/service.js';
let resources;
export function getResources() {
  if (!resources) throw new Error('Travel resources are not initialized');
  return resources;
}
export const name = 'travel-resources';
export function apply(ctx) {
  if (resources) throw new Error('Only one travel resource owner may run per process');
  const directory = resolve(process.env.DATA_DIR || resolve(root, 'data'));
  const release = acquireLock(directory);
  let db;
  try { db = openDatabase(resolve(directory, 'travel.db')); } catch (error) { release(); throw error; }
  const browser = new BrowserService(db, { ...browserOptions(resolve(directory, 'browser')), headless: true, maxSessions: 4 });
  const maps = new MapService(db);
  let closing;
  resources = { db, plans: new Plans(db), auth: new Auth(db), browser, maps, directory, app: null, close() {
    if (closing) return closing;
    closing = (async () => {
      try { await resources.app?.close(); await maps.close(); await browser.close(); }
      finally { if (db.open) db.close(); release(); resources = undefined; }
    })();
    return closing;
  } };
  ctx.provide('travelResources', { ready: true });
  ctx.effect(() => () => resources?.close());
}
