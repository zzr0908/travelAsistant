import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resources } from './resources.mjs';
import { HarnessDriver } from '../travel/driver.mjs';
import { AgentWorker } from '../../../dist/server/agent/runtime/worker.js';
import { browserOptions } from '../../../dist/server/agent/browser/config.js';
export const name = 'travel-worker';
export const inject = ['travelWorker', 'llm', 'agents', 'tools', 'sessionPersistence', 'systemPrompt', 'sessionProjections', 'appReady'];
export async function apply(ctx) {
  const token = (process.env.TRAVEL_SERVICE_TOKEN_FILE ? readFileSync(process.env.TRAVEL_SERVICE_TOKEN_FILE, 'utf8') : process.env.TRAVEL_SERVICE_TOKEN || '').trim();
  if (token.length < 32) throw new Error('Missing service credential');
  const worker = new AgentWorker(process.env.APP_INTERNAL_URL || 'http://127.0.0.1:4319', token, { ...browserOptions(resolve(process.env.AGENT_DATA_DIR || 'data-agent')), headless: true, maxSessions: 4 }, new HarnessDriver(ctx, process.env.TRAVEL_GLM_MODEL));
  resources.worker = worker;
  ctx.effect(() => () => worker.close());
  await worker.startHealth(Number(process.env.AGENT_HEALTH_PORT || 4318));
  await worker.start();
  console.log('Agent 服务已连接功能服务；模型运行与浏览器使用独立进程。');
}
