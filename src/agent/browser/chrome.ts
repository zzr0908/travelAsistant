import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { BrowserError } from "./model.js";

export interface ToolReply {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
export interface BrowserBackend {
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolReply>;
  close(): Promise<void>;
}
export interface ChromeOptions {
  profileDirectory: string;
  hosts: readonly string[];
  headless?: boolean;
  executablePath?: string;
  proxyServer?: string;
  autoConnect?: boolean;
  timeoutMs?: number;
}
export class ChromeBackend implements BrowserBackend {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private options: ChromeOptions) {}
  private async connect(signal: AbortSignal) {
    if (this.closing) await this.closing;
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.start(signal).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async start(signal: AbortSignal) {
    signal.throwIfAborted();
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve("chrome-devtools-mcp/package.json"));
    mkdirSync(this.options.profileDirectory, { recursive: true, mode: 0o700 });
    const args = [
      join(root, "build/src/bin/chrome-devtools-mcp.js"),
      "--no-usage-statistics",
      "--no-performance-crux",
      "--categoryPerformance=false",
      "--categoryEmulation=false",
      "--categoryNetwork=false",
      "--experimentalStructuredContent",
      "--pageIdRouting",
      "--viewport=1280x900",
    ];
    if (process.env.BROWSER_NO_SANDBOX === "1") args.push("--chromeArg=--no-sandbox");
    if (this.options.autoConnect) args.push("--autoConnect");
    else {
      args.push(`--userDataDir=${this.options.profileDirectory}`);
      if (this.options.headless) args.push("--headless");
      if (this.options.executablePath)
        args.push(`--executablePath=${this.options.executablePath}`);
      if (this.options.proxyServer)
        args.push(`--proxyServer=${this.options.proxyServer}`);
    }
    // Chrome >=149 enforces these patterns on navigations and subresources.
    // Arbitrary hosts, file URLs and private local app pages are not admitted.
    for (const host of this.options.hosts) {
      args.push(`--allowedUrlPattern=http{s}?://${host}:*/*`);
      if (!/^[\d.]+$/.test(host) && host !== "localhost")
        args.push(`--allowedUrlPattern=http{s}?://*.${host}:*/*`);
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      stderr: "pipe",
      maxBufferSize: 8 * 1024 * 1024,
      env: {
        ...getDefaultEnvironment(),
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
      },
    });
    transport.stderr?.on("data", () => {
      /* Provider diagnostics can contain URLs; return classified errors only. */
    });
    const client = new Client({ name: "travel-browser", version: "1.0.0" });
    this.transport = transport;
    const abort = () => {
      void transport.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.connect(transport, {
        signal,
        timeout: this.options.timeoutMs || 20000,
      });
      const listing = await client.listTools(
        {},
        { signal, timeout: this.options.timeoutMs || 20000 },
      );
      for (const name of [
        "new_page",
        "navigate_page",
        "evaluate_script",
        "close_page",
        "take_screenshot",
      ])
        if (!listing.tools.some((tool) => tool.name === name))
          throw new BrowserError("unavailable", `Chrome 工具缺失：${name}`);
      signal.throwIfAborted();
      this.client = client;
    } catch (error) {
      await transport.close();
      this.transport = undefined;
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolReply> {
    await this.connect(signal);
    signal.throwIfAborted();
    const reply = (await this.client!.callTool(
      { name, arguments: args },
      undefined,
      { signal, timeout: this.options.timeoutMs || 20000 },
    )) as ToolReply;
    if (reply.isError) {
      const text = reply.content.map((c) => c.text || "").join("\n");
      if (/timeout|timed out/i.test(text))
        throw new BrowserError("timeout", "Chrome 页面操作超时。");
      if (
        /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_PROXY|ERR_TUNNEL|ERR_TIMED_OUT|net::/i.test(
          text,
        )
      )
        throw new BrowserError(
          "unavailable",
          "Chrome 未能连接来源页面，请检查网络与代理。",
        );
      if (
        /Chrome 149|requires.*149|URL.*(?:blocked|allowed)|not allowed/i.test(
          text,
        )
      )
        throw new BrowserError(
          "restricted",
          "Chrome 版本或来源访问范围不满足要求。",
        );
      if (/already running|user data directory|browser is already/i.test(text))
        throw new BrowserError(
          "unavailable",
          "专用 Chrome 配置正在被另一实例使用。",
        );
      throw new BrowserError(
        "failed",
        "Chrome 未完成操作；请重新读取页面或重新连接浏览器。",
      );
    }
    return reply;
  }
  async close() {
    if (this.closing) return this.closing;
    const client = this.client,
      transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.closing = (async () => {
      if (client) await client.close();
      else if (transport) await transport.close();
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
export function replyJson<T>(reply: ToolReply): T {
  const text = reply.content
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("\n");
  const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match)
    throw new BrowserError(
      "failed",
      "Chrome 返回内容格式不符，未将其记录为有效证据。",
    );
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    throw new BrowserError("failed", "Chrome 返回了无效 JSON。");
  }
}
