import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import cookie from "@fastify/cookie";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { z, ZodError } from "zod";
import { openDatabase } from "../../storage/database.js";
import { Plans } from "../domain/plans.js";
import { Auth, credentials, hash } from "./auth.js";
import { AppError, ensure } from "../domain/validation.js";
import { AgentService, type AgentOptions } from "../research/service.js";
import { agentRoutes } from "./agent.js";
import type { DB } from "../../storage/database.js";
import type { BrowserApi, BrowserOptions } from '../../shared/browser-port.js';
import { ExecutionBroker } from '../../execution/broker.js';
import { RemoteDriver } from '../../execution/remote-driver.js';
import { BrowserGateway } from '../../execution/browser-gateway.js';
import type { CardExtractor } from '../../cards/import.js';
import { browserRoutes } from "./browser.js";
import { MapService } from '../../maps/service.js';
import type { MapTransportOptions } from '../../maps/transport.js';
import { mapRoutes } from './maps.js';
import { CardError } from '../../shared/cards.js';
import { CardImports } from '../../cards/import.js';
import { cardRoutes } from './cards.js';

export interface AppOptions {
  execution?: { token: string; leaseMs?: number };
  setupToken?: string;
  publicUrl?: string;
  trustProxy?: string[] | number;
  cardExtractor?: CardExtractor;
  database?: string;
  staticRoot?: string;
  logger?: boolean;
  host?: string;
  port?: number;
  browser?: BrowserOptions;
  agent?: AgentOptions;
  maps?: MapTransportOptions;
  resources?: { db: DB; plans: Plans; auth: Auth; browser: BrowserApi; maps?: MapService };
}
export async function createApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-setup-token'] } : false,
    trustProxy: typeof options.trustProxy === 'number' ? (_address: string, hop: number) => hop < (options.trustProxy as number) : options.trustProxy || false,
    bodyLimit: 512 * 1024,
  });
  const db = options.resources?.db || openDatabase(options.database || ":memory:"),
    plans = options.resources?.plans || new Plans(db),
    auth = options.resources?.auth || new Auth(db);
  const attempts = new Map<string, { count: number; reset: number }>();
  await app.register(cookie);
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      ensure(
        req.headers["x-travel-app"] === "1",
        "请通过行间应用提交操作",
        403,
      );
      if (req.headers.origin) {
        let host = "";
        try {
          host = new URL(req.headers.origin).host;
        } catch {}
        ensure(options.publicUrl ? req.headers.origin === new URL(options.publicUrl).origin : host === req.headers.host, "请求来源与应用地址不一致", 403);
      }
    }
    if (
      ["/api/login", "/api/setup", "/api/join"].includes(req.url) &&
      req.method === "POST"
    ) {
      const now = Date.now(),
        key = req.ip;
      for (const [ip, value] of attempts)
        if (value.reset < now) attempts.delete(ip);
      const value = attempts.get(key) || { count: 0, reset: now + 60000 };
      value.count++;
      attempts.set(key, value);
      ensure(value.count <= 20, "尝试次数较多，请一分钟后重试", 429);
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if(error instanceof CardError)return reply.code(error.status).send({message:error.message,code:error.code,path:error.path,objectId:error.objectId});
    if (error instanceof AppError)
      return reply
        .code(error.status)
        .send({ message: error.message, code: error.code });
    if (error instanceof ZodError)
      return reply.code(400).send({
        message: error.issues
          .map((i) => i.message)
          .slice(0, 3)
          .join("；"),
        code: "INVALID",
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply.code(status).send({
        message: status === 413 ? "内容过大，请缩短后重试" : "请求内容无效",
        code: "INVALID",
      });
    req.log.error({ err: error }, "Request failed");
    reply.code(503).send({
      message: "暂时无法保存或读取，请保留输入后重试。",
      code: "UNAVAILABLE",
    });
  });
  const signedIn = (req: { cookies: Record<string, string | undefined> }) =>
    auth.require(req.cookies.travel_session);
  const execution = options.execution ? new ExecutionBroker(db,options.execution.token,options.execution.leaseMs) : undefined;
  const browser: BrowserApi = options.resources?.browser || (execution ? new BrowserGateway(db,execution) : new (await import('../../agent/browser/service.js')).BrowserService(
    db, options.browser || {directory:resolve('.cache/browser'),enabled:false},
  ));
  browserRoutes(app, browser, signedIn);
  const maps = options.resources?.maps || new MapService(db, options.maps);
  mapRoutes(app, maps, signedIn);
  const agent = new AgentService(db, plans, browser, { ...options.agent, maps, ...(execution ? {driver:new RemoteDriver(execution),mediaDownload:async (url:string,signal?:AbortSignal)=>{const {jobId}=await execution.submit('image',{url},{signal,timeoutMs:30000}).promise;return execution.consumeBlobs(jobId,['image'])[0];},mediaProcess:async(original:Buffer,signal?:AbortSignal)=>{
    const {jobId,result}=await execution.submit('image',{process:true},{signal,timeoutMs:30000,blobs:{original}}).promise;
    const [bytes,thumbnail]=execution.consumeBlobs(jobId,['image','thumbnail']);
    ensure(result.sha256===createHash('sha256').update(bytes).digest('hex') && result.thumbnailSha256===createHash('sha256').update(thumbnail).digest('hex') && Number.isSafeInteger(result.width) && Number.isSafeInteger(result.height) && result.width>0 && result.height>0,'图片处理回执无效');
    return {width:result.width,height:result.height,bytes,thumbnail};
  }} : {}) });
  agentRoutes(app, agent, signedIn);
  const cards=new CardImports(db,plans,options.cardExtractor || options.agent?.driver?.extractCards?.bind(options.agent.driver));
  cardRoutes(app,cards,signedIn);
  const session = (
    reply: import("fastify").FastifyReply,
    user: ReturnType<Auth["create"]>,
  ) =>
    reply.setCookie("travel_session", auth.session(user), {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: options.publicUrl?.startsWith('https://') || false,
      maxAge: 30 * 86400,
    });
  const local = (ip: string, hostname: string) =>
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip) &&
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
  app.get("/api/health", async () => ({ ok: true, service: "app", protocol: 1 }));
  app.get("/api/session", async (req) => ({
    user: auth.user(req.cookies.travel_session),
    needsSetup: auth.needsSetup(),
    canSetup: !!options.setupToken || local(req.ip, req.hostname),
    setupRequiresToken: !!options.setupToken,
    agent: agent.capability(),
  }));
  app.post("/api/setup", async (req, reply) => {
    ensure(
      options.setupToken ? hash(String(req.headers["x-setup-token"] || "")) === hash(options.setupToken) : local(req.ip, req.hostname),
      options.setupToken ? "安装凭据不正确，请查看安装目录中的 setup-token" : "首次设置请在部署电脑上打开 localhost 地址完成",
      403,
    );
    const user = db.transaction(() => {
      ensure(auth.needsSetup(), "已完成首次设置，请登录", 409);
      return auth.create(req.body, true);
    })();
    session(reply, user);
    return { user };
  });
  app.post("/api/login", async (req, reply) => {
    const user = auth.login(req.body);
    session(reply, user);
    return { user };
  });
  app.post("/api/logout", async (req, reply) => {
    auth.logout(req.cookies.travel_session);
    reply.clearCookie("travel_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/workspaces", async (req) => ({
    workspaces: plans.list(signedIn(req).id),
  }));
  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (req) =>
    plans.view(req.params.id, signedIn(req).id),
  );
  app.post("/api/commands", async (req) =>
    plans.execute(signedIn(req).id, req.body),
  );
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/invites",
    async (req) => {
      const user = signedIn(req),
        w = plans.access(req.params.id, user.id);
      ensure(
        w.ownerId === user.id && w.data.kind === "trip",
        "仅旅行组织者可以创建邀请",
        403,
      );
      const { role } = z
        .object({ role: z.enum(["editor", "reader"]) })
        .strict()
        .parse(req.body);
      const token = randomBytes(24).toString("base64url"),
        expires = Date.now() + 86400000;
      db.prepare(
        "INSERT INTO invites(token_hash,workspace_id,role,expires) VALUES(?,?,?,?)",
      ).run(hash(token), w.id, role, expires);
      return { token, expires, role };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/invites",
    async (req) => {
      const u = signedIn(req),
        w = plans.access(req.params.id, u.id);
      ensure(w.ownerId === u.id, "仅组织者可以管理邀请", 403);
      return {
        invites: db
          .prepare(
            "SELECT token_hash AS id,role,expires,used FROM invites WHERE workspace_id=? ORDER BY rowid DESC",
          )
          .all(w.id),
      };
    },
  );
  app.delete<{ Params: { id: string; inviteId: string } }>(
    "/api/workspaces/:id/invites/:inviteId",
    async (req) => {
      const u = signedIn(req),
        w = plans.access(req.params.id, u.id);
      ensure(w.ownerId === u.id, "仅组织者可以撤销邀请", 403);
      db.prepare(
        "DELETE FROM invites WHERE workspace_id=? AND token_hash=?",
      ).run(w.id, req.params.inviteId);
      return { ok: true };
    },
  );
  app.post("/api/join", async (req, reply) => {
    const p = z
      .object({
        token: z.string().min(16).max(100),
        credentials: credentials.optional(),
      })
      .strict()
      .parse(req.body);
    const result = db.transaction(() => {
      const invite = db
        .prepare("SELECT * FROM invites WHERE token_hash=?")
        .get(hash(p.token)) as
        | { workspace_id: string; role: string; expires: number; used: number }
        | undefined;
      ensure(
        invite && !invite.used && invite.expires > Date.now(),
        "邀请已使用、过期或被撤销",
        400,
      );
      plans.get(invite.workspace_id);
      const existing = auth.user(req.cookies.travel_session),
        user = existing || auth.create(p.credentials);
      const membership = plans.role(invite.workspace_id, user.id);
      ensure(!membership, "你已加入该旅行，无须重复使用邀请", 409);
      db.prepare(
        "INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)",
      ).run(invite.workspace_id, user.id, invite.role);
      db.prepare("UPDATE invites SET used=1 WHERE token_hash=?").run(
        hash(p.token),
      );
      return { user, workspaceId: invite.workspace_id };
    })();
    session(reply, result.user);
    return result;
  });
  app.get("/api/connection", async (req) => {
    signedIn(req);
    const port = options.port || 4317;
    return {
      local: `http://localhost:${port}`,
      shared: options.host === "0.0.0.0",
      publicUrl: options.publicUrl || null,
      addresses: options.publicUrl ? [options.publicUrl] :
        options.host === "0.0.0.0"
          ? Object.values(networkInterfaces())
              .flat()
              .filter((n) => n?.family === "IPv4" && !n.internal)
              .map((n) => `http://${n!.address}:${port}`)
          : [],
    };
  });
  app.get("/api/backup", async (req, reply) => {
    ensure(signedIn(req).admin, "只有本机管理员可以导出完整备份", 403);
    const dir = resolve(process.env.DATA_DIR || ".cache", "backup-exports");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = resolve(dir, randomBytes(12).toString("hex") + ".db");
    try {
      await db.backup(file);
      const buffer = readFileSync(file);
      reply
        .header(
          "Content-Disposition",
          `attachment; filename="travel-backup-${new Date().toISOString().slice(0, 10)}.db"`,
        )
        .type("application/octet-stream");
      return buffer;
    } finally {
      if (existsSync(file)) unlinkSync(file);
    }
  });
  if (options.staticRoot) {
    await app.register(fastifyStatic, {
      root: resolve(options.staticRoot),
      index: "index.html",
      list: false,
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ message: "找不到接口" })
        : reply.code(404).send({ message: "找不到页面，请返回首页" }),
    );
  }
  app.addHook("onClose", async () => {
    await cards.close();
    await agent.close();
    if (!options.resources?.maps) await maps.close();
    if (!options.resources) {
      await browser.close();
      await execution?.close();
      db.close();
    }
  });
  return { app, db, plans, auth, browser, agent, maps, cards, execution };
}
