import { resolve } from 'node:path';
import { root } from './modules.mjs';
import { getResources } from './resources.mjs';
import { HarnessDriver } from './driver.mjs';
import { createApp } from '../../../dist/server/service/server/app.js';
export const name = 'travel-app';
export const inject = ['travelResources', 'llm', 'agents', 'tools', 'sessionPersistence', 'systemPrompt', 'sessionProjections', 'appReady'];
export async function apply(ctx) {
  const resources = getResources();
  const driver = new HarnessDriver(ctx, process.env.TRAVEL_GLM_MODEL);
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 4317);
  const limits = process.env.TRAVEL_AGENT_LIMITS ? JSON.parse(process.env.TRAVEL_AGENT_LIMITS) : {};
  const { app } = await createApp({ resources, staticRoot: resolve(root, 'dist/client'), host, port, logger: true, agent: { driver, model: process.env.TRAVEL_GLM_MODEL, mode: process.env.TRAVEL_AGENT_MODE === 'development' ? 'development' : 'ordinary', limits } });
  resources.app = app;
  await app.listen({ host, port });
  console.log(`行间 Agent: http://localhost:${port} · ${process.env.TRAVEL_GLM_MODEL}`);
  ctx.effect(() => () => resources.close());
}
