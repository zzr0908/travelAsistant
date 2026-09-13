import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/service/server/app.js";
import {
  nodeFields,
  emptyDates,
  conflicts,
  dateLabel,
  type PlanNode,
} from "../src/shared/model.js";
import { backupDatabase, restoreDatabase } from "../src/storage/maintenance.js";
import { acquireLock } from "../src/storage/runtime-lock.js";

async function fixture(t: TestContext, database = ":memory:") {
  const services = await createApp({ database });
  t.after(() => services.app.close());
  const owner = services.auth.create(
    { username: "owner", password: "testing-password", name: "组织者" },
    true,
  );
  const other = services.auth.create({
    username: "companion",
    password: "testing-password",
    name: "同行者",
  });
  const ownerHeaders = {
    cookie: `travel_session=${services.auth.session(owner)}`,
    "x-travel-app": "1",
    host: "localhost",
  };
  const otherHeaders = {
    cookie: `travel_session=${services.auth.session(other)}`,
    "x-travel-app": "1",
    host: "localhost",
  };
  const run = (
    kind: string,
    payload: Record<string, unknown>,
    workspaceId?: string,
    version?: number,
    userId = owner.id,
  ) =>
    services.plans.execute(userId, {
      requestId: randomUUID(),
      kind,
      payload,
      ...(workspaceId
        ? {
            workspaceId,
            version: version ?? services.plans.get(workspaceId).version,
          }
        : {}),
    });
  const create = (kind: "trip" | "standalone" = "trip", title = "测试旅行") =>
    run("create", { kind, node: nodeFields.parse({ title }) }).workspaceId;
  return { ...services, owner, other, ownerHeaders, otherHeaders, run, create };
}
const fields = (n: PlanNode) => {
  const { id, parentId, order, ...value } = n;
  return value;
};
const temp = (t: TestContext) => {
  const p = mkdtempSync(join(tmpdir(), "travel-tests-"));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
};

test("F01/F15: setup restricted to local host; credentials and session authorize requests", async (t) => {
  const { app } = await createApp();
  t.after(() => app.close());
  const payload = {
    username: "organizer",
    password: "test-password",
    name: "旅伴",
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/setup",
        payload,
        headers: { "x-travel-app": "1", host: "192.168.1.20" },
        remoteAddress: "192.168.1.30",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/setup",
        payload,
        headers: { host: "localhost" },
      })
    ).statusCode,
    403,
  );
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload,
    headers: { "x-travel-app": "1", host: "localhost" },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  assert.ok(setup.headers["set-cookie"]?.toString().includes("HttpOnly"));
  assert.equal((await app.inject("/api/workspaces")).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { ...payload, password: "wrong-password" },
        headers: { "x-travel-app": "1" },
      })
    ).statusCode,
    401,
  );
  const cookie = setup.cookies[0].value;
  assert.equal(
    (
      await app.inject({
        url: "/api/workspaces",
        headers: { cookie: `travel_session=${cookie}` },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/logout",
        headers: {
          cookie: `travel_session=${cookie}`,
          "x-travel-app": "1",
          origin: "https://other.example",
          host: "localhost",
        },
      })
    ).statusCode,
    403,
  );
});

test("F02/F03/F04: independent plans, arbitrary depth and read-only navigation retain data", async (t) => {
  const f = await fixture(t),
    id = f.create("standalone", "独立的一天"),
    root = f.plans.get(id).data.rootId;
  f.run(
    "add",
    {
      parentId: root,
      node: nodeFields.parse({
        title: "文化探索",
        notes: "<script>text only</script>",
      }),
    },
    id,
  );
  const child = Object.values(f.plans.get(id).data.nodes).find(
    (n) => n.parentId === root,
  )!;
  f.run(
    "add",
    { parentId: child.id, node: nodeFields.parse({ title: "一项活动" }) },
    id,
  );
  const before = f.plans.get(id);
  const view = f.plans.view(id, f.owner.id);
  assert.equal(view.data.nodes[child.id].notes, "<script>text only</script>");
  assert.deepEqual(f.plans.get(id), before);
  assert.equal(view.data.nodes[root].dates.mode, "unset");
  assert.throws(() => f.plans.view(id, f.other.id), /权限/);
});

test("F05/F07: move rejects cycles; merge preserves identifiers, relationships and can be undone atomically", async (t) => {
  const f = await fixture(t),
    source = f.create("standalone", "独立的一天"),
    target = f.create("trip", "意大利旅行"),
    root = f.plans.get(source).data.rootId;
  f.run(
    "add",
    { parentId: root, node: nodeFields.parse({ title: "上午" }) },
    source,
  );
  const child = Object.values(f.plans.get(source).data.nodes).find(
    (n) => n.parentId,
  )!;
  assert.throws(
    () => f.run("move", { nodeId: child.id, parentId: child.id }, source),
    /自身或后代/,
  );
  const prepId = randomUUID(),
    stepId = randomUUID();
  f.run(
    "prep",
    {
      preparation: {
        title: "共同准备",
        nodeIds: [root, child.id],
        steps: [{ id: stepId, text: "检查材料" }],
      },
    },
    source,
  );
  f.run("progress", { stepId, done: true }, source);
  const original = f.plans.get(source),
    targetRoot = f.plans.get(target).data.rootId;
  assert.throws(
    () =>
      f.run(
        "merge",
        { targetId: target, targetVersion: 0, parentId: targetRoot },
        source,
      ),
    /更新/,
  );
  assert.deepEqual(f.plans.get(source), original);
  const result = f.run(
    "merge",
    {
      targetId: target,
      targetVersion: f.plans.get(target).version,
      parentId: targetRoot,
    },
    source,
  );
  assert.throws(() => f.plans.get(source), /找不到/);
  const merged = f.plans.get(target);
  assert.equal(merged.data.nodes[root].parentId, targetRoot);
  assert.ok(merged.data.nodes[child.id]);
  assert.equal(merged.data.progress[f.owner.id][stepId], true);
  assert.equal(Object.keys(merged.data.preparations).length, 1);
  f.run("undo", { changeId: result.changeId });
  assert.deepEqual(f.plans.get(source).data, original.data);
  assert.equal(Object.keys(f.plans.get(target).data.nodes).length, 1);
});

test("F05/F07: add, edit and same-trip moves undo only their own scope; ancestor cycles are rejected", async (t) => {
  const f = await fixture(t),
    id = f.run("sample", {}).workspaceId;
  const original = f.plans.get(id).data;
  const fixed = Object.values(original.nodes).find((n) => n.fixed)!;
  const target = Object.values(original.nodes).find(
    (n) => n.title === "乡间自驾",
  )!;
  assert.throws(
    () => f.run("move", { nodeId: fixed.parentId, parentId: fixed.id }, id),
    /自身或后代/,
  );
  const moved = f.run("move", { nodeId: fixed.id, parentId: target.id }, id);
  assert.equal(f.plans.get(id).data.nodes[fixed.id].parentId, target.id);
  assert.deepEqual(f.plans.get(id).data.nodes[fixed.id].dates, fixed.dates);
  f.run("undo", { changeId: moved.changeId });
  assert.deepEqual(f.plans.get(id).data, original);
  const edited = f.run(
    "edit",
    { nodeId: fixed.id, node: { ...fields(fixed), notes: "只修改这一项备注" } },
    id,
  );
  assert.equal(f.plans.get(id).data.nodes[fixed.id].fixed, true);
  f.run("undo", { changeId: edited.changeId });
  assert.deepEqual(f.plans.get(id).data, original);
  const added = f.run(
    "add",
    {
      parentId: original.rootId,
      node: nodeFields.parse({ title: "临时想法" }),
    },
    id,
  );
  assert.equal(
    Object.keys(f.plans.get(id).data.nodes).length,
    Object.keys(original.nodes).length + 1,
  );
  f.run("undo", { changeId: added.changeId });
  assert.deepEqual(f.plans.get(id).data, original);
  const created = f.run("create", {
    kind: "standalone",
    node: nodeFields.parse({ title: "撤销新建" }),
  });
  f.run("undo", { changeId: created.changeId });
  assert.throws(() => f.plans.get(created.workspaceId), /找不到/);
  assert.deepEqual(f.plans.get(id).data, original);
});

test("F06: repeated requests are idempotent, reused identifiers cannot carry different changes", async (t) => {
  const f = await fixture(t);
  const command = {
    requestId: randomUUID(),
    kind: "create",
    payload: { kind: "trip", node: nodeFields.parse({ title: "一次创建" }) },
  };
  const a = f.plans.execute(f.owner.id, command),
    b = f.plans.execute(f.owner.id, command);
  assert.deepEqual(a, b);
  assert.equal(f.plans.list(f.owner.id).length, 1);
  assert.throws(
    () =>
      f.plans.execute(f.owner.id, {
        ...command,
        payload: {
          ...command.payload,
          node: nodeFields.parse({ title: "不同内容" }),
        },
      }),
    /标识/,
  );
});

test("F06: failed write rolls back plan, version and history together", async (t) => {
  const f = await fixture(t),
    id = f.create(),
    w = f.plans.get(id),
    root = w.data.rootId;
  const count = (
    f.db.prepare("SELECT count(*) AS n FROM changes").get() as { n: number }
  ).n;
  f.db.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;",
  );
  assert.throws(
    () =>
      f.run(
        "edit",
        {
          nodeId: root,
          node: { ...fields(w.data.nodes[root]), title: "不能保存" },
        },
        id,
      ),
    /simulated disk failure/,
  );
  assert.deepEqual(f.plans.get(id), w);
  assert.equal(
    (f.db.prepare("SELECT count(*) AS n FROM changes").get() as { n: number })
      .n,
    count,
  );
  f.db.exec("DROP TRIGGER fail_history");
  f.run(
    "edit",
    {
      nodeId: root,
      node: { ...fields(w.data.nodes[root]), title: "重试成功" },
    },
    id,
  );
  assert.equal(f.plans.get(id).data.nodes[root].title, "重试成功");
});

test("F06: SQLite data survives service close and reopen", async (t) => {
  const directory = temp(t),
    database = join(directory, "travel.db");
  const first = await createApp({ database });
  const owner = first.auth.create(
    { username: "owner", password: "test-password" },
    true,
  );
  const result = first.plans.execute(owner.id, {
      requestId: randomUUID(),
      kind: "sample",
      payload: {},
    }),
    saved = first.plans.get(result.workspaceId);
  await first.app.close();
  const second = await createApp({ database });
  t.after(() => second.app.close());
  assert.deepEqual(second.plans.get(result.workspaceId), saved);
  assert.equal(
    second.auth.login({ username: "owner", password: "test-password" }).id,
    owner.id,
  );
});

test("F08/F09: date modes, ranges, cross-month and invalid dates obey distinct rules", async (t) => {
  const f = await fixture(t),
    id = f.create(),
    w = f.plans.get(id),
    root = w.data.rootId,
    node = fields(w.data.nodes[root]);
  for (const dates of [
    { ...emptyDates(), mode: "duration", minDays: 5, maxDays: 7 },
    { ...emptyDates(), mode: "window", start: "2026-10-01", end: "2026-10-07" },
    { ...emptyDates(), mode: "fixed", start: "2026-10-31", end: "2026-11-02" },
  ]) {
    f.run("edit", { nodeId: root, node: { ...node, dates } }, id);
    assert.deepEqual(f.plans.get(id).data.nodes[root].dates, dates);
  }
  assert.equal(
    dateLabel({ ...emptyDates(), mode: "duration", minDays: 5, maxDays: 7 }),
    "5—7 天",
  );
  for (const dates of [
    { ...emptyDates(), mode: "fixed", start: "2026-02-30", end: "2026-03-01" },
    { ...emptyDates(), mode: "fixed", start: "2026-10-02", end: "2026-10-01" },
    { ...emptyDates(), mode: "duration", minDays: 7, maxDays: 5 },
  ])
    assert.throws(() =>
      f.run("edit", { nodeId: root, node: { ...node, dates } }, id),
    );
  const before = f.plans.get(id);
  for (const timezone of ["Pacific/Honolulu", "Asia/Shanghai", "Europe/Rome"]) {
    process.env.TZ = timezone;
    assert.equal(
      dateLabel(before.data.nodes[root].dates),
      "2026-10-31 — 2026-11-02",
    );
  }
  delete process.env.TZ;
});

test("F09/F10: parent date changes retain fixed appointments and expose conflicts", async (t) => {
  const f = await fixture(t),
    id = f.run("sample", {}).workspaceId,
    w = f.plans.get(id),
    fixed = Object.values(w.data.nodes).find((n) => n.fixed)!,
    root = w.data.nodes[w.data.rootId];
  f.run(
    "edit",
    {
      nodeId: root.id,
      node: {
        ...fields(root),
        dates: { ...root.dates, start: "2026-10-05", end: "2026-10-07" },
      },
    },
    id,
  );
  assert.deepEqual(f.plans.get(id).data.nodes[fixed.id], fixed);
  assert.ok(conflicts(f.plans.get(id).data).some((c) => c.nodeId === fixed.id));
  assert.throws(
    () =>
      f.run(
        "edit",
        {
          nodeId: fixed.id,
          node: {
            ...fields(fixed),
            dates: { ...fixed.dates, start: "2026-10-06", end: "2026-10-06" },
          },
        },
        id,
      ),
    /固定安排/,
  );
});

test("F09: timed overlaps are visible, adjacent times are allowed, and a fixed date change needs explicit confirmation", async (t) => {
  const f = await fixture(t),
    id = f.run("sample", {}).workspaceId;
  const original = f.plans.get(id).data;
  const fixed = Object.values(original.nodes).find((n) => n.fixed)!;
  const lunch = Object.values(original.nodes).find(
    (n) => n.title === "午餐与咖啡",
  )!;
  const edited = {
    ...fields(lunch),
    dates: { ...lunch.dates, startTime: "10:30", endTime: "12:00" },
  };
  f.run("edit", { nodeId: lunch.id, node: edited }, id);
  assert.ok(
    conflicts(f.plans.get(id).data).some((c) => c.message.includes("重叠")),
  );
  f.run(
    "edit",
    {
      nodeId: lunch.id,
      node: { ...edited, dates: { ...edited.dates, startTime: "11:00" } },
    },
    id,
  );
  assert.ok(
    !conflicts(f.plans.get(id).data).some((c) => c.message.includes("重叠")),
  );
  assert.throws(() =>
    f.run(
      "edit",
      {
        nodeId: lunch.id,
        node: {
          ...edited,
          dates: { ...edited.dates, startTime: "13:00", endTime: "12:00" },
        },
      },
      id,
    ),
  );
  const moved = {
    ...fields(fixed),
    dates: { ...fixed.dates, start: "2026-10-04", end: "2026-10-04" },
  };
  f.run("edit", { nodeId: fixed.id, node: moved, confirmFixed: true }, id);
  assert.equal(f.plans.get(id).data.nodes[fixed.id].dates.start, "2026-10-04");
  assert.equal(f.plans.get(id).data.nodes[fixed.id].fixed, true);
});

test("F11/F18: coordinates and untrusted inputs validated at service boundary", async (t) => {
  const f = await fixture(t),
    id = f.create(),
    w = f.plans.get(id),
    node = fields(w.data.nodes[w.data.rootId]);
  for (const location of [
    { name: "地点", address: "", lat: 91, lng: 0 },
    { name: "地点", address: "", lat: 1, lng: null },
  ])
    assert.throws(() =>
      f.run("edit", { nodeId: w.data.rootId, node: { ...node, location } }, id),
    );
  f.run(
    "edit",
    {
      nodeId: w.data.rootId,
      node: {
        ...node,
        location: {
          name: "用户录入地点",
          address: "用户录入地址",
          lat: 43.7,
          lng: 11.2,
        },
      },
    },
    id,
  );
  assert.equal(f.plans.get(id).data.nodes[w.data.rootId].location.lat, 43.7);
  const response = await f.app.inject({
    method: "POST",
    url: "/api/commands",
    headers: f.ownerHeaders,
    payload: {
      requestId: randomUUID(),
      kind: "create",
      payload: { kind: "trip", node: { title: "" } },
    },
  });
  assert.equal(response.statusCode, 400);
});

test("F12/F13/F15: shared preparations deduplicate; read-only members own their progress", async (t) => {
  const f = await fixture(t),
    id = f.run("sample", {}).workspaceId;
  f.db
    .prepare("INSERT INTO members VALUES(?,?,?)")
    .run(id, f.other.id, "reader");
  const w = f.plans.get(id),
    prep = Object.values(w.data.preparations)[0],
    stepId = prep.steps[0].id;
  const { id: prepId, ...preparation } = prep;
  f.run(
    "prep",
    {
      prepId,
      preparation: {
        ...preparation,
        nodeIds: [...prep.nodeIds, prep.nodeIds[0]],
      },
    },
    id,
  );
  assert.equal(Object.keys(f.plans.get(id).data.preparations).length, 1);
  assert.equal(f.plans.get(id).data.preparations[prepId].nodeIds.length, 2);
  f.run("progress", { stepId, done: true }, id);
  const result = f.run(
    "progress",
    { stepId, done: true },
    id,
    undefined,
    f.other.id,
  );
  assert.equal(f.plans.get(id).data.progress[f.owner.id][stepId], true);
  assert.equal(f.plans.get(id).data.progress[f.other.id][stepId], true);
  assert.ok(
    f.plans.history(id, f.other.id).find((h) => h.id === result.changeId)
      ?.canUndo,
  );
  f.run(
    "undo",
    { changeId: result.changeId },
    undefined,
    undefined,
    f.other.id,
  );
  assert.equal(f.plans.get(id).data.progress[f.owner.id][stepId], true);
  assert.equal(f.plans.get(id).data.progress[f.other.id]?.[stepId], undefined);
  assert.throws(
    () =>
      f.run(
        "add",
        {
          parentId: w.data.rootId,
          node: nodeFields.parse({ title: "越权修改" }),
        },
        id,
        undefined,
        f.other.id,
      ),
    /只读/,
  );
});

test("F15: invitations are single-use, revocable, expiring and role-scoped", async (t) => {
  const f = await fixture(t),
    id = f.create();
  const invite = await f.app.inject({
    method: "POST",
    url: `/api/workspaces/${id}/invites`,
    headers: f.ownerHeaders,
    payload: { role: "reader" },
  });
  assert.equal(invite.statusCode, 200, invite.body);
  const token = invite.json().token;
  const joined = await f.app.inject({
    method: "POST",
    url: "/api/join",
    headers: f.otherHeaders,
    payload: { token },
  });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(f.plans.role(id, f.other.id), "reader");
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/join",
        headers: f.otherHeaders,
        payload: { token },
      })
    ).statusCode,
    400,
  );
  for (const invalidation of ["revoke", "expire"] as const) {
    const pending = await f.app.inject({
      method: "POST",
      url: `/api/workspaces/${id}/invites`,
      headers: f.ownerHeaders,
      payload: { role: "editor" },
    });
    assert.equal(pending.statusCode, 200);
    const listing = await f.app.inject({
      url: `/api/workspaces/${id}/invites`,
      headers: f.ownerHeaders,
    });
    const pendingId = listing
      .json()
      .invites.find((i: { used: number }) => !i.used).id;
    if (invalidation === "revoke") {
      const denied = await f.app.inject({
        method: "DELETE",
        url: `/api/workspaces/${id}/invites/${pendingId}`,
        headers: f.otherHeaders,
      });
      assert.equal(denied.statusCode, 403);
      const removed = await f.app.inject({
        method: "DELETE",
        url: `/api/workspaces/${id}/invites/${pendingId}`,
        headers: f.ownerHeaders,
      });
      assert.equal(removed.statusCode, 200);
    } else
      f.db
        .prepare("UPDATE invites SET expires=? WHERE token_hash=?")
        .run(Date.now() - 1, pendingId);
    const rejected = await f.app.inject({
      method: "POST",
      url: "/api/join",
      headers: f.otherHeaders,
      payload: { token: pending.json().token },
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.body, /过期或被撤销/);
  }
  const read = await f.app.inject({
    url: `/api/workspaces/${id}`,
    headers: f.otherHeaders,
  });
  assert.equal(read.statusCode, 200);
  const privateId = f.create("standalone", "未分享的私人计划");
  assert.equal(
    (
      await f.app.inject({
        url: `/api/workspaces/${privateId}`,
        headers: f.otherHeaders,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.app.inject({ url: "/api/backup", headers: f.otherHeaders }))
      .statusCode,
    403,
  );
  assert.ok(
    !(
      await f.app.inject({ url: "/api/workspaces", headers: f.otherHeaders })
    ).body.includes("未分享的私人计划"),
  );
});

test("F07/F16/F17: two sessions cannot overwrite a newer version or undo someone else’s change", async (t) => {
  const f = await fixture(t),
    id = f.create();
  f.db
    .prepare("INSERT INTO members VALUES(?,?,?)")
    .run(id, f.other.id, "editor");
  const original = f.plans.get(id),
    root = original.data.nodes[original.data.rootId];
  const a = f.run(
    "edit",
    { nodeId: root.id, node: { ...fields(root), title: "组织者修改" } },
    id,
    original.version,
  );
  const stale = await f.app.inject({
    method: "POST",
    url: "/api/commands",
    headers: f.otherHeaders,
    payload: {
      requestId: randomUUID(),
      kind: "edit",
      workspaceId: id,
      version: original.version,
      payload: {
        nodeId: root.id,
        node: { ...fields(root), title: "同行者旧修改" },
      },
    },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(f.plans.get(id).data.nodes[root.id].title, "组织者修改");
  const latest = await f.app.inject({
    url: `/api/workspaces/${id}`,
    headers: f.otherHeaders,
  });
  assert.equal(latest.json().version, original.version + 1);
  f.run(
    "edit",
    {
      nodeId: root.id,
      node: { ...fields(root), title: "同行者重新核对后修改" },
    },
    id,
    undefined,
    f.other.id,
  );
  assert.throws(() => f.run("undo", { changeId: a.changeId }), /此后已有修改/);
  assert.equal(
    f.plans.get(id).data.nodes[root.id].title,
    "同行者重新核对后修改",
  );
});

test("F07: unrelated workspace activity does not hide a valid undo history", async (t) => {
  const f = await fixture(t),
    quiet = f.create("standalone", "保留历史的计划"),
    busy = f.create();
  const w = f.plans.get(busy),
    root = w.data.nodes[w.data.rootId];
  for (let i = 0; i < 305; i++)
    f.run(
      "edit",
      {
        nodeId: root.id,
        node: { ...fields(root), notes: `其他旅行的第 ${i} 次修改` },
      },
      busy,
    );
  const history = f.plans.history(quiet, f.owner.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].canUndo, true);
});

test("F19: consistent backup restores graph, history, memberships and edits; bad backup preserves existing data", async (t) => {
  const directory = temp(t),
    dbPath = join(directory, "original", "travel.db");
  const f = await fixture(t, dbPath),
    id = f.run("sample", {}).workspaceId;
  f.db
    .prepare("INSERT INTO members VALUES(?,?,?)")
    .run(id, f.other.id, "reader");
  const preparation = Object.values(f.plans.get(id).data.preparations)[0];
  f.run(
    "progress",
    { stepId: preparation.steps[0].id, done: true },
    id,
    undefined,
    f.owner.id,
  );
  f.run(
    "progress",
    { stepId: preparation.steps[1].id, done: true },
    id,
    undefined,
    f.other.id,
  );
  await f.app.inject({
    method: "POST",
    url: `/api/workspaces/${id}/invites`,
    headers: f.ownerHeaders,
    payload: { role: "editor" },
  });
  const downloaded = await f.app.inject({
    url: "/api/backup",
    headers: f.ownerHeaders,
  });
  assert.equal(downloaded.statusCode, 200);
  assert.ok(downloaded.headers["content-disposition"]?.includes("attachment"));
  assert.equal(
    downloaded.rawPayload.subarray(0, 15).toString(),
    "SQLite format 3",
  );
  const backup = join(directory, "backup.db");
  await backupDatabase(dbPath, backup);
  const restored = join(directory, "restored");
  await restoreDatabase(backup, restored);
  const second = await createApp({ database: join(restored, "travel.db") });
  t.after(() => second.app.close());
  assert.deepEqual(second.plans.get(id).data, f.plans.get(id).data);
  assert.equal(
    second.plans.history(id, f.owner.id).length,
    f.plans.history(id, f.owner.id).length,
  );
  assert.equal(second.plans.role(id, f.owner.id), "owner");
  assert.equal(second.plans.role(id, f.other.id), "reader");
  assert.equal(
    (
      second.db.prepare("SELECT count(*) AS n FROM invites").get() as {
        n: number;
      }
    ).n,
    0,
  );
  const signedIn = await second.app.inject({
    method: "POST",
    url: "/api/login",
    headers: { "x-travel-app": "1", host: "localhost" },
    payload: { username: "companion", password: "testing-password" },
  });
  assert.equal(signedIn.statusCode, 200);
  assert.equal(
    second.plans.get(id).data.progress[f.other.id][preparation.steps[1].id],
    true,
  );
  // Logout restores the expected empty session table for the next assertion.
  second.db.prepare("DELETE FROM sessions").run();
  assert.equal(
    (
      second.db.prepare("SELECT count(*) AS n FROM sessions").get() as {
        n: number;
      }
    ).n,
    0,
  );
  const w = second.plans.get(id);
  second.plans.execute(f.owner.id, {
    requestId: randomUUID(),
    kind: "edit",
    workspaceId: id,
    version: w.version,
    payload: {
      nodeId: w.data.rootId,
      node: { ...fields(w.data.nodes[w.data.rootId]), title: "恢复后继续编辑" },
    },
  });
  const broken = join(directory, "broken.db");
  writeFileSync(broken, "not sqlite");
  await assert.rejects(() => restoreDatabase(broken, restored));
  assert.equal(
    second.plans.get(id).data.nodes[w.data.rootId].title,
    "恢复后继续编辑",
  );
  const release = acquireLock(restored);
  try {
    await assert.rejects(() => restoreDatabase(backup, restored), /正在使用/);
  } finally {
    release();
  }
});

test('notebook: shared references persist, stale edits and readers are rejected, deletion is reversible', async t => {
  const f = await fixture(t);
  const wid = f.create(), root = f.plans.get(wid).data.rootId;
  f.run('add', { parentId: root, node: nodeFields.parse({ title: '散步' }) }, wid);
  const child = Object.values(f.plans.get(wid).data.nodes).find(n => n.parentId === root)!.id;
  const fields = { title: '沿河散步攻略', body: '# 老桥\n\n原文与[来源](https://example.org)\n\n- 看河景', nodeIds: [root, child], preparationIds: [], mediaIds: [] };
  f.run('note', { note: fields }, wid);
  const saved = f.plans.get(wid), note = Object.values(saved.data.notebook!)[0];
  assert.equal(note.body, fields.body);
  assert.deepEqual(note.nodeIds, [root, child]);
  assert.equal(Object.keys(saved.data.nodes).length, 2, 'saving a note must not add itinerary nodes');
  assert.throws(() => f.run('note', { noteId: note.id, note: { ...fields, body: 'stale edit' } }, wid, saved.version - 1), /已有更新/);
  f.db.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'reader')").run(wid, f.other.id);
  assert.equal(f.plans.view(wid, f.other.id).data.notebook![note.id].body, fields.body);
  assert.throws(() => f.run('note', { noteId: note.id, note: fields }, wid, saved.version, f.other.id), /只读/);
  assert.throws(() => f.run('note', { note: { ...fields, nodeIds: ['missing'] } }, wid), /关联的计划不存在/);
  assert.equal(Object.keys(f.plans.get(wid).data.notebook!).length, 1);
  const deleted = f.run('deleteNote', { noteId: note.id }, wid);
  assert.equal(Object.keys(f.plans.get(wid).data.notebook!).length, 0);
  f.run('undo', { changeId: deleted.changeId });
  assert.equal(f.plans.get(wid).data.notebook![note.id].body, fields.body);
});

test('notebook migration preserves original text, shared progress, repeat identity and reversible edits', async t => {
  const f = await fixture(t), wid = f.run('sample', {}).workspaceId;
  const before = f.plans.get(wid), root = before.data.rootId;
  f.run('edit', {nodeId:root,node:{...fields(before.data.nodes[root]),notes:'人工原文\\n不是换行\n\n第二段'}},wid);
  const original = structuredClone(f.plans.get(wid).data);
  const migration = f.run('migrateNotes',{},wid);
  const migrated = f.plans.get(wid), notes = Object.values(migrated.data.notebook!);
  assert.deepEqual(migrated.data.nodes, original.nodes);
  assert.deepEqual(migrated.data.preparations, original.preparations);
  assert.deepEqual(migrated.data.progress, original.progress);
  const memo=notes.find(n=>n.origin?.kind==='notes'&&n.origin.sourceId===root)!;
  assert.equal(memo.body,original.nodes[root].notes);
  const checklist=notes.find(n=>n.origin?.kind==='preparation')!;
  assert.deepEqual(checklist.preparationIds,[checklist.origin!.sourceId]);
  f.run('migrateNotes',{},wid);
  assert.deepEqual(f.plans.get(wid).data.notebook,migrated.data.notebook);
  const {id,origin,createdAt,updatedAt,...input}=memo;
  f.run('note',{noteId:id,note:{...input,body:'笔记修改后的原文'}},wid);
  assert.equal(f.plans.get(wid).data.nodes[root].notes,'笔记修改后的原文');
  const edit=f.run('edit',{nodeId:root,node:{...fields(f.plans.get(wid).data.nodes[root]),notes:'旧编辑入口修改'}},wid);
  assert.equal(f.plans.get(wid).data.notebook![id].body,'旧编辑入口修改');
  f.run('undo',{changeId:edit.changeId});
  assert.equal(f.plans.get(wid).data.notebook![id].body,'笔记修改后的原文');
  const separate=f.create();
  const saved=f.plans.get(separate);
  f.run('edit',{nodeId:saved.data.rootId,node:{...fields(saved.data.nodes[saved.data.rootId]),description:'原介绍'}},separate);
  const conversion=f.run('migrateNotes',{},separate);
  f.run('undo',{changeId:conversion.changeId});
  assert.equal(f.plans.get(separate).data.notebook,undefined);
  assert.equal(f.plans.get(separate).data.nodes[saved.data.rootId].description,'原介绍');
});

test('reorder preserves dates and references, rejects chronological conflict and supports undo', async t => {
  const f=await fixture(t),wid=f.create(),root=f.plans.get(wid).data.rootId;
  for(const title of ['老桥','广场','咖啡']) f.run('add',{parentId:root,node:nodeFields.parse({title})},wid);
  const before=f.plans.get(wid),ids=Object.values(before.data.nodes).filter(n=>n.parentId===root).map(n=>n.id);
  const changed=f.run('reorder',{parentId:root,nodeIds:[ids[2],ids[0],ids[1]]},wid);
  const reordered=f.plans.get(wid);
  assert.deepEqual(Object.values(reordered.data.nodes).filter(n=>n.parentId===root).sort((a,b)=>a.order-b.order).map(n=>n.id),[ids[2],ids[0],ids[1]]);
  for(const id of ids)assert.deepEqual(reordered.data.nodes[id].dates,before.data.nodes[id].dates);
  assert.throws(()=>f.run('reorder',{parentId:root,nodeIds:[ids[0],ids[0],ids[1]]},wid),/完整包含/);
  f.run('undo',{changeId:changed.changeId});assert.deepEqual(f.plans.get(wid).data,before.data);
  for(let i=0;i<2;i++) f.run('edit',{nodeId:ids[i],node:{...fields(f.plans.get(wid).data.nodes[ids[i]]),dates:{...emptyDates(),mode:'fixed',start:'2026-10-01',end:'2026-10-01',startTime:i?'15:00':'09:00'}}},wid);
  const scheduled=f.plans.get(wid);
  assert.throws(()=>f.run('reorder',{parentId:root,nodeIds:[ids[1],ids[0],ids[2]]},wid),/确定时间冲突/);
  assert.deepEqual(f.plans.get(wid),scheduled,'rejected ordering must not change data or version');
});

test('removing a plan preserves material, shared checklists and progress, and undo restores the full subtree',async t=>{
 const f=await fixture(t),wid=f.create(),root=f.plans.get(wid).data.rootId;
 f.run('add',{parentId:root,node:nodeFields.parse({title:'散步',description:'保留介绍',notes:'原始备注'})},wid);
 const parent=Object.values(f.plans.get(wid).data.nodes).find(n=>n.parentId===root)!.id;
 f.run('add',{parentId:parent,node:nodeFields.parse({title:'预约地点',fixed:true})},wid);
 const child=Object.values(f.plans.get(wid).data.nodes).find(n=>n.parentId===parent)!.id;
 f.run('migrateNotes',{},wid);
 f.run('prep',{preparation:{title:'出发清单',note:'原文',nodeIds:[child],steps:[{id:'keep-step',text:'门票'}]}},wid);
 f.run('progress',{stepId:'keep-step',done:true},wid);
 const before=f.plans.get(wid);
 assert.throws(()=>f.run('removePlan',{nodeId:parent},wid),/固定安排/);
 assert.deepEqual(f.plans.get(wid),before);
 assert.throws(()=>f.run('removePlan',{nodeId:root,confirmFixed:true},wid),/子计划/);
 const removed=f.run('removePlan',{nodeId:parent,confirmFixed:true},wid),after=f.plans.get(wid);
 assert.equal(Object.keys(after.data.nodes).length,1);
 assert.ok(Object.values(after.data.notebook!).some(n=>n.body.includes('原始备注')));
 assert.ok(Object.values(after.data.notebook!).every(n=>n.nodeIds.every(id=>!!after.data.nodes[id])));
 assert.deepEqual(Object.values(after.data.preparations)[0].nodeIds,[root]);
 assert.deepEqual(after.data.progress,before.data.progress);
 const dir=temp(t),file=join(dir,'removed.db');await f.db.backup(file);
 const {inspectBackup}=await import('../src/storage/maintenance.js');inspectBackup(file);
 f.run('undo',{changeId:removed.changeId});
 assert.deepEqual(f.plans.get(wid).data,before.data);
});
