import { executionTables, inspectExecutionBackup } from './execution.js';
import { inspectMediaBackup, mediaTables } from './media-backup.js';
import { inspectMapBackup, mapTables } from './map-backup.js';
import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { validateData, ensure } from "../service/domain/validation.js";
import { acquireLock } from "./runtime-lock.js";
import { agentTables, inspectAgentBackup } from "./agent-backup.js";
import { browserRequest, browserResult } from "../shared/browser-model.js";

export function inspectBackup(filename: string) {
  ensure(existsSync(filename), "备份文件不存在");
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma("user_version", { simple: true }) as number;
    ensure([1, 2, 3, 4, 5, 6, 7, 8].includes(version), "备份版本不受支持");
    ensure(
      db.pragma("integrity_check", { simple: true }) === "ok",
      "备份完整性检查失败",
    );
    ensure(
      (db.pragma("foreign_key_check") as unknown[]).length === 0,
      "备份关联损坏",
    );
    const tables = (
      db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {
        name: string;
      }[]
    )
      .map((x) => x.name)
      .sort();
    ensure(
      JSON.stringify(tables) ===
        JSON.stringify(
          [
            "users",
            "sessions",
            "workspaces",
            "members",
            "invites",
            "changes",
            ...(version >= 2 ? ["browser_queries", "browser_artifacts"] : []),
            ...(version >= 3 ? agentTables : []),
            ...(version >= 4 ? mediaTables : []),
            ...(version >= 5 ? mapTables : []),
            ...(version >= 7 ? ['card_drafts'] : []),
            ...(version >= 8 ? executionTables : []),
          ].sort(),
        ),
      "备份结构不正确",
    );
    ensure(
      !db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").get(),
      "备份包含不受支持的触发器",
    );
    for (const row of db
      .prepare("SELECT id,data,owner_id FROM workspaces")
      .all() as { id: string; data: string; owner_id: string }[]) {
      validateData(JSON.parse(row.data));
      ensure(
        db
          .prepare(
            "SELECT 1 FROM members WHERE workspace_id=? AND user_id=? AND role='owner'",
          )
          .get(row.id, row.owner_id),
        "备份中的组织者关联无效",
      );
    }
    if (version >= 2) {
      for (const row of db
        .prepare("SELECT id,input,result FROM browser_queries")
        .all() as { id: string; input: string; result: string | null }[]) {
        browserRequest.parse(JSON.parse(row.input));
        if (row.result) {
          const result = browserResult.parse(JSON.parse(row.result));
          ensure(result.queryId === row.id, "浏览器查询证据关联无效");
          if (result.data)
            ensure(
              createHash("sha256").update(result.data.text).digest("hex") ===
                result.data.textHash,
              "浏览器文本证据校验失败",
            );
          if (result.artifact)
            ensure(
              db
                .prepare(
                  "SELECT 1 FROM browser_artifacts WHERE id=? AND query_id=?",
                )
                .get(result.artifact.id, row.id),
              "浏览器图片证据缺失",
            );
        }
      }
      for (const row of db
        .prepare(
          "SELECT a.*,q.owner_id AS query_owner,q.result AS query_result FROM browser_artifacts a JOIN browser_queries q ON q.id=a.query_id",
        )
        .all() as {
        id: string;
        owner_id: string;
        query_owner: string;
        sha256: string;
        bytes: Buffer;
        query_result: string | null;
      }[]) {
        ensure(
          row.owner_id === row.query_owner &&
            createHash("sha256").update(row.bytes).digest("hex") === row.sha256,
          "浏览器图片证据或归属校验失败",
        );
        const artifact = row.query_result
          ? browserResult.parse(JSON.parse(row.query_result)).artifact
          : null;
        ensure(
          artifact &&
            artifact.id === row.id &&
            artifact.sha256 === row.sha256 &&
            artifact.byteLength === row.bytes.length,
          "浏览器图片与查询结果不一致",
        );
      }
    }
    if (version >= 8) inspectExecutionBackup(db);
    if (version >= 3) inspectAgentBackup(db);
    if (version >= 4) inspectMediaBackup(db);
    if (version >= 5) inspectMapBackup(db);
    return {
      workspaces: (
        db
          .prepare("SELECT count(*) AS n FROM workspaces WHERE deleted=0")
          .get() as { n: number }
      ).n,
      users: (
        db.prepare("SELECT count(*) AS n FROM users").get() as { n: number }
      ).n,
    };
  } finally {
    db.close();
  }
}
export async function backupDatabase(source: string, destination: string) {
  ensure(
    resolve(source) !== resolve(destination),
    "备份路径不能覆盖正在使用的数据",
  );
  ensure(!existsSync(destination), "目标备份文件已存在");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  return inspectBackup(destination);
}
export async function restoreDatabase(source: string, directory: string) {
  inspectBackup(source);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = join(directory, "travel.db");
  ensure(resolve(source) !== resolve(database), "请从独立的备份文件恢复");
  const release = acquireLock(directory);
  const temp = join(directory, `.restore-${randomUUID()}.db`);
  const previous = join(directory, `before-restore-${Date.now()}.db`);
  let archived = false;
  try {
    await backupDatabase(source, temp);
    const check = new Database(temp);
    try {
      check.exec("DELETE FROM sessions; DELETE FROM invites;");
      check.pragma("journal_mode = DELETE");
    } finally {
      check.close();
    }
    inspectBackup(temp);
    if (existsSync(database)) {
      await backupDatabase(database, previous);
      archived = true;
      const old = new Database(database);
      try {
        old.pragma("wal_checkpoint(TRUNCATE)");
        old.pragma("journal_mode = DELETE");
      } finally {
        old.close();
      }
    }
    renameSync(temp, database);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(database + suffix)) unlinkSync(database + suffix);
    return { ...inspectBackup(database), previous: archived ? previous : null };
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const directory = resolve(process.env.DATA_DIR || "data");
  const action = process.argv[2];
  try {
    if (action === "backup") {
      const file = resolve(
        process.argv[3] ||
          join(
            directory,
            "backups",
            `travel-${new Date().toISOString().replace(/[:.]/g, "-")}.db`,
          ),
      );
      console.log({
        file,
        ...(await backupDatabase(join(directory, "travel.db"), file)),
      });
    } else if (action === "restore") {
      ensure(process.argv[3], "用法：npm run restore -- /完整路径/备份.db");
      console.log(await restoreDatabase(resolve(process.argv[3]), directory));
    } else throw new Error("请选择 backup 或 restore");
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
