import { executionTables } from '../src/storage/execution.js';
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../src/storage/database.js";
import { BrowserService } from "../src/agent/browser/service.js";
import { mediaTables } from '../src/storage/media-backup.js';
import { mapTables } from '../src/storage/map-backup.js';
import { agentTables } from "../src/storage/agent-backup.js";
import { BrowserStore } from "../src/agent/browser/store.js";
import { BrowserError, browserRequest } from "../src/agent/browser/model.js";
import type { BrowserBackend, ToolReply } from "../src/agent/browser/chrome.js";
import {
  canonicalUrl,
  privateAddress,
  validateUrl,
} from "../src/agent/browser/sources.js";
import {
  inspectBackup,
  backupDatabase,
  restoreDatabase,
} from "../src/storage/maintenance.js";
import { createApp } from "../src/service/server/app.js";

import { FakeChrome } from './fixtures/fake-chrome.js';
const read = (extra = {}) => ({
  action: "read",
  url: "https://en.wikipedia.org/wiki/Uffizi",
  requestId: randomUUID(),
  ...extra,
});
function setup(t: { after: (fn: () => unknown) => void }, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "travel-browser-test-"));
  const db = openDatabase(join(dir, "travel.db"));
  const backends: FakeChrome[] = [];
  const service = new BrowserService(db, {
    directory: dir,
    settleMs: 0,
    backendFactory: () => {
      const backend = new FakeChrome();
      backends.push(backend);
      return backend;
    },
    ...config,
  });
  t.after(async () => {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db, service, backends };
}

test("browser: evidence keeps scope, missing fields and media limits; retry executes once", async (t) => {
  const { service, backends, db } = setup(t);
  const request = read({
    context: {
      destination: "Florence",
      dates: "2026-10-03",
      conditions: { ticket: "standard" },
    },
  });
  const result = await service.execute("alice", request);
  assert.equal(result.status, "partial");
  assert.equal(result.data?.verification, "unverified");
  assert.equal(result.data?.comments[0].publishedAt, "09-01");
  assert.equal(result.data?.comments[0].experiencedAt, null);
  assert.ok(result.missing.includes("remaining_comments"));
  assert.ok(result.missing.includes("media_interpretation"));
  assert.equal(result.usage.cost, null);
  assert.doesNotMatch(JSON.stringify(result), /xsec_token|secret|utm_source/);
  const calls = backends[0].calls.length;
  assert.deepEqual(await service.execute("alice", request), result);
  assert.equal(backends[0].calls.length, calls);
  await assert.rejects(
    service.execute("alice", {
      ...request,
      url: "https://en.wikipedia.org/wiki/Rome",
    }),
    /requestId/,
  );
  const next = await service.execute("alice", {
    action: "capture",
    pageId: result.data!.pageId,
    requestId: randomUUID(),
  });
  assert.equal(next.context.dates, "2026-10-03");
  assert.equal(
    new BrowserStore(db).get("alice", result.queryId).result?.data?.title,
    "Uffizi",
  );
});

test("browser: user scope prevents reading another user's evidence or controlling their tab", async (t) => {
  const { service } = setup(t);
  const first = await service.execute("alice", read());
  assert.throws(() => service.store.get("bob", first.queryId), /当前用户/);
  assert.throws(() => service.cancel("bob", first.queryId), /当前用户/);
  const captured = await service.execute("bob", {
    action: "capture",
    pageId: first.data!.pageId,
    requestId: randomUUID(),
  });
  assert.equal(captured.status, "needs_input");
  assert.equal(captured.data, null);
  assert.notEqual(
    (await service.execute("bob", read())).data!.pageId,
    first.data!.pageId,
  );
});

test("browser: same-user calls are serialized and stale links cannot be followed", async (t) => {
  const { service, backends } = setup(t);
  const [first] = await Promise.all([
    service.execute("alice", read()),
    service.execute("alice", read()),
  ]);
  assert.equal(backends[0].maxActive, 1);
  await service.execute("alice", {
    action: "capture",
    pageId: first.data!.pageId,
    requestId: randomUUID(),
  });
  const old = await service.execute("alice", {
    action: "follow",
    pageId: first.data!.pageId,
    snapshotId: first.data!.snapshotId,
    linkId: "link-0",
    requestId: randomUUID(),
  });
  assert.equal(old.status, "needs_input");
  assert.equal(backends[0].calls.includes("navigate_page"), false);
});

test("browser: cancellation closes backend, stops further dispatch and persists cancelled", async (t) => {
  const { service, backends } = setup(t);
  await service.execute("alice", read());
  backends[0].slow = true;
  const begun = service.start("alice", read());
  await delay(10);
  service.cancel("alice", begun.queryId);
  for (
    let i = 0;
    i < 30 && !service.store.get("alice", begun.queryId).result;
    i++
  )
    await delay(5);
  const result = service.store.get("alice", begun.queryId).result!;
  assert.equal(result.status, "cancelled");
  assert.equal(result.data, null);
  assert.ok(backends[0].closed > 0);
  const count = backends[0].calls.length;
  await delay(30);
  assert.equal(backends[0].calls.length, count);
});

test("browser: login wall retains resumable handle without storing login contents", async (t) => {
  const { service, backends } = setup(t);
  await service.execute("alice", read());
  backends[0].login = true;
  const result = await service.execute("alice", read());
  assert.equal(result.status, "needs_input");
  assert.equal(result.data?.text, "");
  assert.equal(result.data?.links.length, 0);
  assert.equal(result.data?.comments.length, 0);
  assert.ok(result.data?.pageId);
  assert.equal(result.data?.evidenceId, null);
  assert.equal(result.evidenceIds.length, 0);
});

test("browser: timeout is separate from cancellation; missing backend is not success", async (t) => {
  const { service } = setup(t, {
    timeoutMs: 10,
    backendFactory: () => {
      const backend = new FakeChrome();
      backend.slow = true;
      return backend;
    },
  });
  const timedOut = await service.execute("alice", read());
  assert.equal(timedOut.status, "timeout");
  assert.ok(timedOut.limitations.some((item) => item.includes("旧 pageId")));
});

test("browser: public URL checks and strict action schemas reject arbitrary execution", async () => {
  for (const url of [
    "file:///etc/passwd",
    "http://127.0.0.1",
    "https://user:password@en.wikipedia.org/wiki/Uffizi",
    "https://en.wikipedia.org.evil.example",
    "https://en.wikipedia.org:4317",
  ])
    await assert.rejects(validateUrl(url, ["wikipedia.org"]), BrowserError);
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
  ])
    assert.equal(privateAddress(ip), true);
  assert.equal(privateAddress("8.8.8.8"), false);
  assert.equal(privateAddress("2001:4860:4860::8888"), false);
  assert.equal(privateAddress("2001:db8::1"), true);
  await assert.rejects(
    validateUrl(
      "https://en.wikipedia.org",
      ["wikipedia.org"],
      false,
      AbortSignal.abort(),
    ),
    /abort/i,
  );
  assert.throws(() =>
    browserRequest.parse({
      ...read(),
      function: "fetch('file:///etc/passwd')",
    }),
  );
  assert.equal(
    canonicalUrl(
      "https://www.xiaohongshu.com/explore/id?xsec_token=private&utm_source=x#fragment",
    ),
    "https://www.xiaohongshu.com/explore/id",
  );
  assert.equal(
    canonicalUrl(
      "https://www.reddit.com/r/florence/?solution=temporary&jsc_token=secret&js_challenge=1&q=Uffizi",
    ),
    "https://www.reddit.com/r/florence/?q=Uffizi",
  );
});

test("browser: backup includes text and image evidence; restore recovers interrupted work", async (t) => {
  const { service, dir, db } = setup(t);
  const first = await service.execute("alice", read());
  const shot = await service.execute("alice", {
    action: "screenshot",
    pageId: first.data!.pageId,
    requestId: randomUUID(),
  });
  assert.ok(shot.artifact);
  assert.throws(
    () => service.store.artifact("bob", shot.artifact!.id),
    /当前用户/,
  );
  const pending = service.store.begin("alice", browserRequest.parse(read()));
  const backup = join(dir, "backup.db");
  await backupDatabase(join(dir, "travel.db"), backup);
  inspectBackup(backup);
  await restoreDatabase(backup, join(dir, "restored"));
  const restored = openDatabase(join(dir, "restored/travel.db"));
  try {
    const store = new BrowserStore(restored);
    store.recover();
    assert.equal(store.get("alice", pending.id).result?.status, "interrupted");
    assert.equal(
      store.artifact("alice", shot.artifact!.id).sha256,
      shot.artifact!.sha256,
    );
  } finally {
    restored.close();
  }
  db.prepare("UPDATE browser_artifacts SET bytes=? WHERE id=?").run(
    Buffer.from("bad"),
    shot.artifact!.id,
  );
  assert.throws(() => inspectBackup(join(dir, "travel.db")), /证据/);
});

test("browser: legacy v1 databases restore and migrate without losing existing users", async (t) => {
  const { dir, db } = setup(t);
  db.pragma("foreign_keys=OFF");
  for (const name of [...agentTables, ...mediaTables, ...mapTables, ...executionTables, 'card_drafts'].reverse()) db.exec(`DROP TABLE ${name}`);
  db.exec(
    "DROP TABLE browser_artifacts; DROP TABLE browser_queries; PRAGMA user_version=1",
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password) VALUES('existing','existing','Existing','hash')",
  ).run();
  await restoreDatabase(join(dir, "travel.db"), join(dir, "legacy-restored"));
  const migrated = openDatabase(join(dir, "legacy-restored/travel.db"));
  try {
    assert.equal(migrated.pragma("user_version", { simple: true }), 8);
    assert.ok(
      migrated.prepare("SELECT id FROM users WHERE id='existing'").get(),
    );
  } finally {
    migrated.close();
  }
});

test("browser: app API binds authenticated users and returns asynchronous query handles", async (t) => {
  const { dir } = setup(t);
  const app = await createApp({
    browser: {
      directory: dir,
      settleMs: 0,
      backendFactory: () => new FakeChrome(),
    },
  });
  t.after(() => app.app.close());
  const user = app.auth.create(
    { username: "browseruser", name: "Reader", password: "valid-password" },
    true,
  );
  const headers = {
    cookie: `travel_session=${app.auth.session(user)}`,
    "x-travel-app": "1",
    host: "localhost",
  };
  assert.equal(
    (await app.app.inject({ url: "/api/browser/status" })).statusCode,
    401,
  );
  const started = await app.app.inject({
    method: "POST",
    url: "/api/browser/queries",
    headers,
    payload: read(),
  });
  assert.equal(started.statusCode, 202);
  const queryId = started.json().queryId;
  let response;
  for (let i = 0; i < 50; i++) {
    response = await app.app.inject({
      url: `/api/browser/queries/${queryId}`,
      headers,
    });
    if (response.json().result) break;
    await delay(5);
  }
  assert.equal(response!.json().result.data.title, "Uffizi");
  assert.equal(
    (await app.app.inject({ url: `/api/browser/queries/${queryId}` }))
      .statusCode,
    401,
  );
});

test('AP15: releasing an agent lease leaves the same owner manual page and other owner intact', async t => {
 const {service,backends}=setup(t,{maxSessions:4});
 const manual=await service.execute('owner',read());
 const peer=await service.execute('peer',read());
 const agentPage=await service.execute('owner',read(),undefined,'agent:run');
 assert.equal(backends.length,3);
 backends[2].slow=true;
 const pending=service.execute('owner',{action:'capture',pageId:agentPage.data!.pageId,requestId:randomUUID()},undefined,'agent:run');
 await delay(5);await service.releaseLease('agent:run');assert.equal((await pending).status,'cancelled');
 assert.equal(backends[0].closed,0);assert.equal(backends[1].closed,0);assert.ok(backends[2].closed>=1);
 assert.notEqual((await service.execute('owner',{action:'capture',pageId:manual.data!.pageId,requestId:randomUUID()})).status,'failed');
 assert.notEqual((await service.execute('peer',{action:'capture',pageId:peer.data!.pageId,requestId:randomUUID()})).status,'failed');
});
