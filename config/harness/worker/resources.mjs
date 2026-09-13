export const name = 'travel-worker-resources';
export const resources = { worker: null };
export function apply(ctx) { ctx.provide('travelWorker', resources); }
