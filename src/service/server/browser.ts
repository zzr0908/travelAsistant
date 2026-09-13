import type { FastifyInstance } from "fastify";
import type { BrowserApi } from "../../shared/browser-port.js";
import { BrowserError } from "../../agent/browser/model.js";
import { AppError } from "../domain/validation.js";

export function browserRoutes(
  app: FastifyInstance,
  service: BrowserApi,
  identify: (req: { cookies: Record<string, string | undefined> }) => {
    id: string;
  },
) {
  const safe = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof BrowserError)
        throw new AppError(
          error.status === "restricted" ? 403 : 409,
          error.message,
        );
      throw error;
    }
  };
  app.get("/api/browser/status", async (req) => {
    identify(req);
    return service.status();
  });
  app.post("/api/browser/queries", async (req, reply) => {
    const result = safe(() => service.start(identify(req).id, req.body));
    return reply.code(202).send(result);
  });
  app.get("/api/browser/queries", async (req) => ({
    queries: service.store.list(identify(req).id),
  }));
  app.get<{ Params: { id: string } }>("/api/browser/queries/:id", async (req) =>
    safe(() => service.store.get(identify(req).id, req.params.id)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/browser/queries/:id/cancel",
    async (req) => safe(() => service.cancel(identify(req).id, req.params.id)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/browser/artifacts/:id",
    async (req, reply) => {
      const artifact = safe(() =>
        service.store.artifact(identify(req).id, req.params.id),
      );
      return reply.type(artifact.mimeType).send(artifact.bytes);
    },
  );
  app.post("/api/browser/disconnect", async (req) => {
    await service.disconnect(identify(req).id);
    return { disconnected: true };
  });
}
