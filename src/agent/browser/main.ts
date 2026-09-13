import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, chmodSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "../../storage/database.js";
import { acquireLock } from "../../storage/runtime-lock.js";
import { BrowserService } from "./service.js";
import { browserOptions } from "./config.js";
import { browserMcp } from "./mcp.js";

// Standalone tool mode owns its own data directory. The web application embeds
// BrowserService with the application's already-open database instead.
const directory = resolve(process.env.BROWSER_DATA_DIR || "data/browser-tools");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const release = acquireLock(directory);
const db = openDatabase(join(directory, "travel.db"));
chmodSync(join(directory, "travel.db"), 0o600);
const service = new BrowserService(db, {
  ...browserOptions(directory),
  autoConnect: process.env.BROWSER_AUTO_CONNECT === "1",
});
let closing: Promise<void> | undefined;
const close = () =>
  (closing ||= (async () => {
    await service.close();
    db.close();
    release();
  })());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void close().then(() => process.exit(0));
  });

const command = process.argv[2] || "help";
try {
  if (command === "mcp") {
    const server = browserMcp(service);
    await server.connect(new StdioServerTransport());
    process.stdin.once("end", () => {
      void close().then(() => server.close());
    });
  } else if (command === "session") {
    // A newline-delimited JSON interface preserves page handles across requests.
    const lines = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        console.log(
          JSON.stringify(
            await service.execute("local", {
              requestId: randomUUID(),
              ...JSON.parse(line),
            }),
          ),
        );
      } catch {
        console.log(
          JSON.stringify({ error: "请求格式无效，请使用 action 及对应字段。" }),
        );
      }
    }
    await close();
  } else {
    let out: unknown;
    if (command === "status") out = service.status();
    else if (command === "list") out = service.store.list("local");
    else if (command === "get")
      out = service.store.get("local", process.argv[3]);
    else if (command === "query")
      out = await service.execute("local", {
        requestId: randomUUID(),
        ...JSON.parse(readFileSync(process.argv[3], "utf8")),
      });
    else if (command === "read" || command === "screenshot") {
      const page = await service.execute("local", {
        action: "read",
        url: process.argv[3],
        requestId: randomUUID(),
      });
      out = page;
      if (command === "screenshot" && page.data)
        out = await service.execute("local", {
          action: "screenshot",
          pageId: page.data.pageId,
          requestId: randomUUID(),
        });
    } else if (command === "search")
      out = await service.execute("local", {
        action: "search",
        source: process.argv[3],
        query: process.argv.slice(4).join(" "),
        requestId: randomUUID(),
      });
    else if (command === "login") {
      const page = await service.execute("local", {
        action: "login",
        source: process.argv[3],
        requestId: randomUUID(),
      });
      console.log(JSON.stringify(page, null, 2));
      if (!process.stdin.isTTY || !page.data)
        out = {
          message:
            "交互终端中运行 login 可保持窗口；MCP 或 session 模式也可保持浏览器会话。",
        };
      else {
        const lines = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        await new Promise<void>((done) =>
          lines.question(
            "请在专用 Chrome 中完成登录，完成后按回车保存并关闭：",
            () => {
              lines.close();
              done();
            },
          ),
        );
        out = await service.execute("local", {
          action: "capture",
          pageId: page.data.pageId,
          requestId: randomUUID(),
        });
      }
    } else
      out = {
        usage: [
          "npm run browser -- status",
          "npm run browser -- read https://www.uffizi.it/en/the-uffizi",
          "npm run browser -- search wikipedia Uffizi",
          "npm run browser -- login xiaohongshu",
          "npm run browser -- screenshot URL",
          "npm run browser -- query request.json",
          "npm run browser -- list",
          "npm run browser -- get QUERY_ID",
          "npm run browser -- session",
          "npm run browser:mcp",
        ],
        dataDirectory: directory,
      };
    console.log(JSON.stringify(out, null, 2));
    await close();
  }
} catch {
  console.error(
    "浏览器命令未完成，请检查参数、Chrome 和数据目录；未输出密钥或原始提供方日志。",
  );
  await close();
  process.exitCode = 1;
}
