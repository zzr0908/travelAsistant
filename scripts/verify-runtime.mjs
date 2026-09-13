import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

const directory = await mkdtemp(join(tmpdir(), "travel-runtime-"));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let processHandle;
let logs = "";
async function start() {
  processHandle = spawn(
    process.execPath,
    ["dist/server/service/server/main.js"],
    {
      env: {
        ...process.env,
        DATA_DIR: directory,
        HOST: "127.0.0.1",
        PORT: String(port),
        INTERNAL_PORT: "0",
        TRAVEL_ENV_FILE: join(directory,"missing.env"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processHandle.stdout.on("data", (chunk) => (logs += chunk));
  processHandle.stderr.on("data", (chunk) => (logs += chunk));
  for (let i = 0; i < 50; i++) {
    if (processHandle.exitCode !== null)
      throw new Error(`Startup failed: ${logs}`);
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Startup timed out");
}
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const closed = once(processHandle, "exit");
  processHandle.kill("SIGTERM");
  const timer = setTimeout(() => processHandle.kill("SIGKILL"), 5000);
  try {
    const [code] = await closed;
    assert.equal(code, 0, "Application must shut down cleanly");
  } finally {
    clearTimeout(timer);
  }
}
try {
  await start();
  const html = await (await fetch(base)).text();
  assert.ok(html.includes("行间"));
  assert.ok((await fetch(base + "/favicon.svg")).ok);
  const setupToken=(await readFile(join(directory,"config/setup-token"),"utf8")).trim();
  const post = (path, body, cookie = "") =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-setup-token": setupToken,
        "x-travel-app": "1",
        cookie,
      },
      body: JSON.stringify(body),
    });
  const setup = await post("/api/setup", {
    username: "runtime_owner",
    password: "runtime-test-password",
    name: "运行验收",
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const command = { requestId: randomUUID(), kind: "sample", payload: {} };
  const unacknowledged = await post("/api/commands", command, cookie);
  assert.equal(unacknowledged.status, 200);
  await unacknowledged.body.cancel(); // Response body deliberately discarded before reading the result.
  const retry = await post("/api/commands", command, cookie);
  assert.equal(retry.status, 200);
  const saved = await retry.json();
  const list = await (
    await fetch(base + "/api/workspaces", { headers: { cookie } })
  ).json();
  assert.equal(
    list.workspaces.length,
    1,
    "Retry after lost acknowledgement must not create a duplicate",
  );
  const before = await (
    await fetch(base + `/api/workspaces/${saved.workspaceId}`, {
      headers: { cookie },
    })
  ).json();
  await stop();
  await start();
  const after = await (
    await fetch(base + `/api/workspaces/${saved.workspaceId}`, {
      headers: { cookie },
    })
  ).json();
  assert.deepEqual(after.data, before.data);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.history, before.history);
  await stop();
  console.log(
    "PASS F01/F06/F17: compiled single process serves UI + SQLite; fresh setup; discarded response retry creates once; clean stop/restart retains session, graph, version and history.",
  );
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      port,
      dataDirectory: "temporary, removed after verification",
    }),
  );
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
