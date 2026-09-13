import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MapService } from '../../maps/service.js';

function connectionSignal(req: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController();
  const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
  req.raw.once('aborted', abort); reply.raw.once('close', abort);
  return { signal: controller.signal, release() { req.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort); } };
}
export function mapRoutes(app: FastifyInstance, maps: MapService, identify: (req: { cookies: Record<string, string | undefined> }) => { id: string }) {
  app.get('/api/maps/status', async req => { identify(req); return maps.status(); });
  app.post('/api/maps/queries', async (req, reply) => {
    const user = identify(req), connection = connectionSignal(req, reply);
    try { return await maps.query(user.id, req.body, { signal: connection.signal }); }
    finally { connection.release(); }
  });
  app.get<{ Params: { id: string }; Querystring: { workspaceId?: string } }>('/api/maps/assets/:id', async req => {
    const user = identify(req), input = z.object({ workspaceId: z.string().uuid().optional() }).strict().parse(req.query);
    return maps.store.allowed(z.string().uuid().parse(req.params.id), user.id, input.workspaceId);
  });
  app.post('/api/maps/asset-set', async req => {
    const user = identify(req), input = z.object({ ids: z.array(z.string().uuid()).max(600), workspaceId: z.string().uuid().optional() }).strict().parse(req.body);
    return { assets: maps.store.readMany(input.ids, user.id, input.workspaceId) };
  });
  app.get<{ Params: { '*': string } }>('/api/maps/resources/*', async (req, reply) => {
    identify(req);
    z.object({}).strict().parse(req.query);
    const connection = connectionSignal(req, reply);
    try {
      const r = await maps.resource(req.params['*'], connection.signal);
      // The server cache saves upstream calls, while every client request is authenticated.
      return reply.header('Cache-Control', 'private, no-store').header('X-Map-Cache', r.cached ? 'hit' : 'miss').type(r.mime).send(r.bytes);
    } finally { connection.release(); }
  });
}
