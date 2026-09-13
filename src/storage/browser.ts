import { randomUUID } from "node:crypto";
import { digest } from "../shared/hash.js";
export { digest } from "../shared/hash.js";
import type { DB } from "./database.js";
import {
  BrowserError,
  browserResult,
  type BrowserRequest,
  type BrowserResult,
} from "../shared/browser-model.js";
import { canonicalUrl } from "../shared/browser-sources.js";

type Row = {
  id: string;
  owner_id: string;
  request_hash: string;
  input: string;
  state: string;
  result: string | null;
  created: string;
  updated: string;
};
export class BrowserStore {
  constructor(private db: DB) {}
  begin(owner: string, input: BrowserRequest) {
    const hash = digest(JSON.stringify(input));
    const previous = this.db
      .prepare(
        "SELECT * FROM browser_queries WHERE owner_id=? AND request_id=?",
      )
      .get(owner, input.requestId) as Row | undefined;
    if (previous) {
      if (previous.request_hash !== hash)
        throw new BrowserError(
          "restricted",
          "同一 requestId 不能携带不同查询。",
        );
      return { id: previous.id, existing: true };
    }
    const safeInput =
      input.action === "read"
        ? { ...input, url: canonicalUrl(input.url) }
        : input;
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO browser_queries(id,owner_id,request_id,request_hash,input,state,created,updated) VALUES(?,?,?,?,?,'queued',?,?)",
      )
      .run(
        id,
        owner,
        input.requestId,
        hash,
        JSON.stringify(safeInput),
        now,
        now,
      );
    return { id, existing: false };
  }
  state(id: string, state: string) {
    this.db
      .prepare(
        "UPDATE browser_queries SET state=?,updated=? WHERE id=? AND result IS NULL",
      )
      .run(state, new Date().toISOString(), id);
  }
  finish(owner: string, result: BrowserResult, bytes?: Buffer) {
    browserResult.parse(result);
    this.db.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE browser_queries SET state=?,result=?,updated=? WHERE id=? AND owner_id=? AND result IS NULL",
        )
        .run(
          result.status,
          JSON.stringify(result),
          result.retrievedAt,
          result.queryId,
          owner,
        );
      if (!changed.changes)
        throw new BrowserError("failed", "查询结果已结算或不属于当前会话。");
      if (bytes && result.artifact)
        this.db
          .prepare(
            "INSERT INTO browser_artifacts(id,query_id,owner_id,mime_type,sha256,bytes,created) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            result.artifact.id,
            result.queryId,
            owner,
            result.artifact.mimeType,
            result.artifact.sha256,
            bytes,
            result.retrievedAt,
          );
    })();
  }
  get(owner: string, id: string) {
    const row = this.db
      .prepare("SELECT * FROM browser_queries WHERE owner_id=? AND id=?")
      .get(owner, id) as Row | undefined;
    if (!row) throw new BrowserError("restricted", "找不到当前用户的查询。");
    return {
      queryId: row.id,
      state: row.state,
      input: JSON.parse(row.input) as BrowserRequest,
      created: row.created,
      result: row.result ? browserResult.parse(JSON.parse(row.result)) : null,
    };
  }
  list(owner: string) {
    return this.db
      .prepare(
        "SELECT id AS queryId,state,created,updated FROM browser_queries WHERE owner_id=? ORDER BY created DESC,rowid DESC LIMIT 30",
      )
      .all(owner);
  }
  artifact(owner: string, id: string) {
    const row = this.db
      .prepare(
        "SELECT mime_type AS mimeType,bytes,sha256 FROM browser_artifacts WHERE owner_id=? AND id=?",
      )
      .get(owner, id) as
      | { mimeType: string; bytes: Buffer; sha256: string }
      | undefined;
    if (!row)
      throw new BrowserError("restricted", "找不到当前用户的图片证据。");
    return row;
  }
  recover() {
    const rows = this.db
      .prepare("SELECT * FROM browser_queries WHERE result IS NULL")
      .all() as Row[];
    for (const row of rows) {
      const input = JSON.parse(row.input) as BrowserRequest;
      this.finish(row.owner_id, {
        schemaVersion: 1,
        queryId: row.id,
        capability: `browser.${input.action}`,
        providerId: "chrome-devtools-mcp",
        status: "interrupted",
        data: null,
        evidenceIds: [],
        artifact: null,
        context: input.context,
        missing: ["query_result"],
        limitations: ["服务上次停止时查询尚未结算；不会自动重复页面操作。"],
        retrievedAt: new Date().toISOString(),
        durationMs: 0,
        usage: { toolCalls: 0, browserRequests: null, cost: null },
        message: "查询已中断，请用新的 requestId 重新查询。",
      });
    }
  }
}
