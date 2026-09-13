import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase } from "../dist/server/storage/database.js";
import { BrowserService } from "../dist/server/agent/browser/service.js";
import { browserMcp } from "../dist/server/agent/browser/mcp.js";
import {
  backupDatabase,
  inspectBackup,
} from "../dist/server/storage/maintenance.js";

const dir = mkdtempSync(join(tmpdir(), "travel-browser-runtime-"));
const db = openDatabase(join(dir, "travel.db"));
const checks = [];
const requests = [];
const fixture = createServer((req, res) => {
  requests.push({ url: req.url, host: req.headers.host });
  if (req.url === "/slow")
    return setTimeout(() => {
      if (!res.destroyed) res.end("<main>Slow content</main>");
    }, 10000);
  if (req.url === "/pixel") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhKcAAAAASUVORK5CYII=",
        "base64",
      ),
    );
  }
  if (req.url === "/login") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(
      '<title>Sign in</title><main><input type="password" value="private">Log in to continue</main>',
    );
  }
  if (req.url === "/challenge") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(
      "<title>Reddit - Prove your humanity</title><main>Complete verification to continue.</main>",
    );
  }
  if (req.url === "/missing") {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end("<main>Page not found</main>");
  }
  if (req.url?.startsWith("/next")) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(
      "<title>Next source</title><main>Followed the observed link.</main>",
    );
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><head><title>Travel research fixture</title><meta property="article:published_time" content="2026-09-01T12:00:00Z"><style>body{font:18px system-ui;margin:40px;color:#18253a;background:#f5f7fb}main{max-width:800px}button{padding:12px}img{width:30px;height:30px}.comment-item{padding:12px;border:1px solid #abc}</style></head><body><main>
    <h1>Florence museum research</h1><p>Opening hours and ticket conditions belong to the selected date.</p>
    <a href="/next?xsec_token=temporary-secret&utm_source=fixture">Read the next source</a>
    <figure><img src="/pixel" alt="Museum image"><figcaption>Image reference only</figcaption></figure>
    <div class="comments-container"><span class="total">共 2 条</span><div class="comment-item"><span class="author">First visitor</span><time datetime="2026-09-01">09-01</time><p class="comment-text">Arrive early. Date of experience: August 2026</p></div>
    <div class="comment-item" id="second" style="display:none"><span class="author">Second visitor</span><p class="comment-text">Allow time for the queue.</p></div></div>
    <button onclick="document.getElementById('second').style.display='block';this.remove()">Show more comments</button>
    <p>${"Long travel content. ".repeat(200)}</p>
    <img src="http://localhost:${fixture.address().port}/blocked-probe" alt="Blocked network probe">
    </main></body></html>`);
});
await new Promise((ok) => fixture.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${fixture.address().port}`;
const service = new BrowserService(db, {
  directory: dir,
  hosts: ["127.0.0.1"],
  allowLocalTest: true,
  headless: true,
  settleMs: 150,
});
const run = (request) =>
  service.execute("runtime", { requestId: randomUUID(), ...request });
let mcp, client;
try {
  const first = await run({
    action: "read",
    url: base,
    maxChars: 500,
    context: {
      destination: "Florence",
      dates: "2026-10-03",
      conditions: { ticket: "standard" },
    },
  });
  assert.ok(first.data, JSON.stringify(first));
  assert.match(first.data.text, /Florence museum/);
  assert.equal(first.data.comments.length, 1);
  assert.equal(first.data.counts.commentsTotal, 2);
  assert.equal(first.data.publishedAt, "2026-09-01T12:00:00Z");
  assert.equal(first.data.textRange.nextOffset, 500);
  assert.doesNotMatch(
    JSON.stringify(first),
    /temporary-secret|xsec_token|utm_source/,
  );
  checks.push(
    "real Chrome: text, dates, source links, visible comments, truncation and URL redaction",
  );
  const expanded = await run({
    action: "expand",
    pageId: first.data.pageId,
    snapshotId: first.data.snapshotId,
    controlId: first.data.controls[0].id,
  });
  assert.equal(expanded.data?.comments.length, 2, JSON.stringify(expanded));
  assert.equal(expanded.context.dates, "2026-10-03");
  checks.push(
    "real Chrome: observed expansion control reveals an additional comment",
  );
  const slice = await run({
    action: "capture",
    pageId: first.data.pageId,
    startChar: 1000,
    maxChars: 500,
  });
  assert.equal(slice.data?.textRange.start, 1000);
  assert.equal(slice.data?.text.length, 500);
  checks.push("real Chrome: long page can be read in bounded character ranges");
  const scrolled = await run({ action: "scroll", pageId: first.data.pageId });
  assert.ok(scrolled.data?.viewport.scrollY > 0);
  const shot = await run({ action: "screenshot", pageId: first.data.pageId });
  assert.ok(shot.artifact, JSON.stringify(shot));
  const screenshot = service.store.artifact("runtime", shot.artifact.id);
  assert.ok(screenshot.bytes.length > 1000);
  mkdirSync(".cache/browser-qa", { recursive: true });
  writeFileSync(".cache/browser-qa/fixture.jpg", screenshot.bytes, {
    mode: 0o600,
  });
  checks.push(
    "real Chrome: scrolling and JPEG screenshot stored as a private artifact",
  );
  const link = shot.data.links.find(
    (link) => link.text === "Read the next source",
  );
  const followed = await run({
    action: "follow",
    pageId: shot.data.pageId,
    snapshotId: shot.data.snapshotId,
    linkId: link.id,
  });
  assert.equal(followed.data?.title, "Next source");
  assert.ok(
    requests.some((r) => r.url.includes("xsec_token=temporary-secret")),
  );
  assert.doesNotMatch(JSON.stringify(followed), /temporary-secret|xsec_token/);
  checks.push(
    "real Chrome: follows exact observed URL while keeping temporary parameters out of evidence",
  );
  assert.equal(
    requests.some((r) => r.url === "/blocked-probe"),
    false,
    "Chrome must block subresources on unapproved hosts",
  );
  checks.push(
    "real Chrome: network allowlist blocks an unapproved subresource host",
  );
  const login = await run({ action: "read", url: `${base}/login` });
  assert.equal(login.status, "needs_input");
  assert.equal(login.data.text, "");
  assert.doesNotMatch(JSON.stringify(login), /private/);
  const missing = await run({ action: "read", url: `${base}/missing` });
  assert.equal(missing.status, "no_match");
  const challenge = await run({ action: "read", url: `${base}/challenge` });
  assert.equal(challenge.status, "restricted");
  assert.equal(challenge.data.text, "");
  assert.equal(challenge.evidenceIds.length, 0);
  await run({ action: "close", pageId: challenge.data.pageId });
  checks.push(
    "real Chrome: login wall and HTTP 404 are distinguished from successful content",
  );
  checks.push(
    "real Chrome: human-verification page is restricted and never saved as travel evidence",
  );
  const slow = service.start("runtime", {
    action: "read",
    url: `${base}/slow`,
    requestId: randomUUID(),
  });
  await new Promise((ok) => setTimeout(ok, 300));
  service.cancel("runtime", slow.queryId);
  for (
    let i = 0;
    i < 100 && !service.store.get("runtime", slow.queryId).result;
    i++
  )
    await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(
    service.store.get("runtime", slow.queryId).result?.status,
    "cancelled",
  );
  const after = await run({ action: "read", url: base });
  assert.ok(after.data, JSON.stringify(after));
  checks.push(
    "real Chrome: cancellation closes the provider; a fresh query can reconnect",
  );
  mcp = browserMcp(service, "runtime");
  client = new Client({ name: "browser-qa", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "travel_browser_query"));
  const saved = await client.callTool({
    name: "travel_browser_get_query",
    arguments: { queryId: first.queryId },
  });
  assert.equal(
    saved.structuredContent.result.data.title,
    "Travel research fixture",
  );
  checks.push(
    "MCP: typed tool discovery and persisted evidence retrieval through the SDK",
  );
  await backupDatabase(join(dir, "travel.db"), join(dir, "backup.db"));
  inspectBackup(join(dir, "backup.db"));
  checks.push("backup: real text and screenshot hashes validate together");
  // Verify the distributable stdio entry point using a separate data directory.
  const stdioClient = new Client({ name: "browser-stdio-qa", version: "1" });
  const stdioTransport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/server/agent/browser/main.js"), "mcp"],
    stderr: "pipe",
    env: { ...getDefaultEnvironment(), BROWSER_DATA_DIR: join(dir, "stdio") },
  });
  stdioTransport.stderr?.on("data", () => {});
  try {
    await stdioClient.connect(stdioTransport);
    const status = await stdioClient.callTool({
      name: "travel_browser_status",
      arguments: {},
    });
    assert.equal(status.structuredContent.providerVersion, "1.8.0");
  } finally {
    await stdioClient.close();
  }
  checks.push("MCP: built standalone entry starts and responds over stdio");
  const report = {
    checkedAt: new Date().toISOString(),
    provider: "chrome-devtools-mcp@1.8.0",
    node: process.version,
    scope:
      "Real headless Chrome against a local fixture, plus MCP and backup. Does not assert content-platform access.",
    checks,
    status: "passed",
  };
  writeFileSync(
    "docs/qa/browser-runtime.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (client) await client.close();
  if (mcp) await mcp.close();
  await service.close();
  db.close();
  fixture.closeAllConnections();
  await new Promise((ok) => fixture.close(ok));
  rmSync(dir, { recursive: true, force: true });
}
