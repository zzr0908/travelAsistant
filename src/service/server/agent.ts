import { workspaceMediaIds } from '../../shared/notes.js';
import { Trajectory, redact } from '../research/trajectory.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MediaAsset } from '../../shared/agent.js';
import type { User } from '../../shared/model.js';
import { spatialObjectLabel } from '../../shared/maps.js';
import type { AgentService } from '../research/service.js';
import { AppError } from '../domain/validation.js';

export function agentRoutes(app: FastifyInstance, agent: AgentService, signedIn: (req: FastifyRequest) => User) {
  const streams = new Set<() => void>();
  const trace = new Trajectory(agent.db);
  app.get<{ Params: { id: string }; Querystring: { offset?: string; q?: string; filter?: string } }>('/api/agent/runs/:id/trajectory', async req => {
    agent.access(req.params.id, signedIn(req).id);
    const options = z.object({ offset: z.coerce.number().int().min(0).default(0), q: z.string().max(300).optional(), filter: z.enum(['key','all','errors','model','tools','changes']).default('key') }).parse(req.query);
    return redact(trace.page(req.params.id, options));
  });
  app.get<{ Params: { id: string; event: string } }>('/api/agent/runs/:id/trajectory/:event', async req => { agent.access(req.params.id, signedIn(req).id); return redact(trace.detail(req.params.id, req.params.event)); });
  app.get<{ Params: { id: string } }>('/api/agent/runs/:id/trajectory-export', async (req, reply) => {
    agent.access(req.params.id, signedIn(req).id);
    const result = trace.export(req.params.id);
    return reply.header('Content-Disposition', `attachment; filename="travel-trajectory-${req.params.id}.json"`).type('application/json; charset=utf-8').send(JSON.stringify(result, null, 2));
  });
  app.get<{ Params: { id: string }; Querystring: { workspaceId?: string; size?: string } }>('/api/media/:id', async (req, reply) => {
    const row = agent.media.allowed(req.params.id, signedIn(req).id, req.query.workspaceId);
    const bytes = req.query.size === 'thumb' ? row.thumbnail : row.bytes;
    if (!bytes) return reply.code(404).send({ message: '图片尚未保存，可查看来源文字' });
    return reply.type('image/webp').header('Content-Length', bytes.length).send(bytes);
  });
  app.get<{ Params: { id: string }; Querystring: { nodeId?: string } }>('/api/workspaces/:id/media', async req => {
    const owner = signedIn(req).id, w = agent.plans.access(req.params.id, owner);
    const ids = req.query.nodeId ? w.data.media?.[req.query.nodeId] || [] : workspaceMediaIds(w.data);
    const mapIds = req.query.nodeId ? (w.data.spatial?.[req.query.nodeId] || []).map(ref => ref.assetId) : [];
    let mapNames: Record<string, string> = {};
    try {
      mapNames = Object.fromEntries((agent.options.maps?.store.readMany(mapIds, owner, w.id) || []).map(asset => [asset.id, spatialObjectLabel(asset)]));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // Saved pictures remain readable if an independent map asset is unavailable.
    }
    return { media: [...new Set(ids)].map(id => redact(agent.media.metadata(id))), mapNames };
  });
  app.post<{ Params: { id: string } }>('/api/media/:id/retry', async req => {
    const owner = signedIn(req).id, result = await agent.media.retry(req.params.id, owner);
    for (const run of agent.db.prepare('SELECT run_id FROM agent_run_media WHERE media_id=?').all(req.params.id) as {run_id:string}[]) agent.event(run.run_id, 'media.retry', {mediaId:result.id,status:result.status,message:result.message});
    return result;
  });
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/media-options', async req => {
    const owner = signedIn(req).id, w = agent.plans.access(req.params.id, owner);
    const shared = new Set(workspaceMediaIds(w.data)), found = new Map<string, MediaAsset>([...shared].map(id => [id,{...agent.media.metadata(id),accessWorkspaceId:w.id}]));
    for (const row of agent.db.prepare("SELECT id FROM media_assets WHERE owner_id=? AND json_extract(metadata,'$.status')='ready'").all(owner) as {id:string}[]) { try {agent.media.allowed(row.id, owner);found.set(row.id,agent.media.metadata(row.id));} catch { /* revoked research */ } }
    return {media: [...found.values()].map(redact)};
  });
  app.get('/api/agent/status', async req => { signedIn(req); return agent.capability(); });
  app.get('/api/agent/sessions', async req => ({ sessions: agent.sessions(signedIn(req).id) }));
  app.get<{ Params: { id: string } }>('/api/agent/sessions/:id', async req => ({ runs: agent.history(req.params.id, signedIn(req).id) }));
  app.post('/api/agent/runs', async (req, reply) => reply.code(202).send(agent.submit(signedIn(req).id, req.body)));
  app.get<{ Params: { id: string } }>('/api/agent/runs/:id', async req => agent.view(req.params.id, signedIn(req).id));
  app.get<{ Params: { id: string } }>('/api/agent/runs/:id/spatial', async req => ({ assets: agent.spatial(req.params.id, signedIn(req).id) }));
  app.post<{ Params: { id: string } }>('/api/agent/runs/:id/cancel', async req => agent.cancel(req.params.id, signedIn(req).id));
  app.post<{ Params: { id: string } }>('/api/agent/questions/:id/answer', async (req, reply) => {
    const input = z.object({ requestId: z.string().uuid(), answer: z.string().max(8000), selectedCandidateId: z.string().min(1).max(100).optional() }).strict().parse(req.body);
    return reply.code(202).send(agent.answer(req.params.id, signedIn(req).id, input));
  });
  app.post<{ Params: { id: string } }>('/api/agent/proposals/:id/apply', async req => {
    const input = z.object({ requestId: z.string().uuid(), revision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/), baseVersion: z.number().int().nullable() }).strict().parse(req.body);
    return agent.proposals.apply(req.params.id, signedIn(req).id, input);
  });
  app.post<{ Params: { id: string } }>('/api/agent/proposals/:id/reject', async req => agent.proposals.reject(req.params.id, signedIn(req).id));
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/agent-evidence', async req => ({ claims: agent.proposals.published(req.params.id, signedIn(req).id) }));
  app.get<{ Params: { id: string }; Querystring: { after?: string; format?: string } }>('/api/agent/runs/:id/events', async (req, reply) => {
    const owner = signedIn(req).id;
    let after = z.coerce.number().int().min(-1).parse(req.headers['last-event-id'] || req.query.after || -1);
    agent.access(req.params.id, owner);
    if (req.query.format === 'json') return { events: agent.events(req.params.id, owner, after) };
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    let ended = false;
    const close = () => { if (ended) return; ended = true; clearInterval(timer); streams.delete(close); reply.raw.end(); };
    const flush = () => {
      if (ended) return;
      try {
        signedIn(req);
        const events = agent.events(req.params.id, owner, after);
        for (const event of events) { reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); after = event.seq; }
        if (!events.length) reply.raw.write(': keepalive\n\n');
      } catch { close(); }
    };
    const timer = setInterval(flush, 1000);
    streams.add(close); reply.raw.on('close', close); flush();
  });
  app.addHook('preClose', async () => { for (const close of streams) close(); await agent.close(); });
}
