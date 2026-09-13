import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectHarnessRun } from "../scripts/lib/harness-browser-report.mjs";

function fixture() {
  const events = [],
    rows = [];
  const invoke = (name, args, output) => {
    const callId = `call-${events.length}`;
    events.push({
      type: "tool/call",
      data: {
        callId,
        name: `mcp__travel__travel_browser_${name}`,
        arguments: JSON.stringify(args),
      },
    });
    events.push({
      type: "tool/result",
      data: {
        message: {
          source: { callId },
          content: [
            {
              type: "tool-result",
              isError: false,
              content: [{ type: "text", text: JSON.stringify(output) }],
            },
          ],
        },
      },
    });
  };
  invoke("status", {}, { enabled: true });
  for (const [i, action] of ["read", "read", "scroll"].entries()) {
    const text = `Source page ${i}`;
    const value = {
      queryId: `query-${i}`,
      status: "partial",
      data: {
        evidenceId: `query-${i}:page`,
        text,
        textHash: createHash("sha256").update(text).digest("hex"),
        url: `https://www.uffizi.it/en/${i === 0 ? "the-uffizi" : "pitti-palace"}`,
      },
      evidenceIds: [`query-${i}:page`],
      missing: ["media_interpretation"],
    };
    rows.push({
      id: value.queryId,
      request_id: `request-${i}`,
      result: JSON.stringify(value),
    });
    invoke("query", { request: { action, requestId: `request-${i}` } }, value);
  }
  invoke("disconnect", {}, { disconnected: true });
  const guide =
    "# 攻略\n" +
    "这是按来源整理的行程建议。".repeat(30) +
    "\n[乌菲兹](https://www.uffizi.it/en/the-uffizi)\n[皮蒂宫](https://www.uffizi.it/en/pitti-palace)\n";
  events.push({
    type: "assistant/message",
    data: {
      message: {
        source: {
          provider: "travel-glm",
          replayState: { response: { responseModel: "glm-test" } },
        },
        content: [{ type: "text", text: guide }],
      },
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 4,
        totalTokens: 9,
      },
    },
  });
  events.push({ type: "turn/end", data: { reason: { kind: "completed" } } });
  return { run: { code: 0, interrupted: false }, events, rows, guide };
}

test("Harness report requires matching model output and durable browser evidence", () => {
  const report = inspectHarnessRun(fixture());
  assert.equal(report.passed, true);
  assert.equal(report.usage.totalTokens, 9);
  assert.equal(report.usage.cost, null);
  const missing = fixture();
  missing.rows.pop();
  assert.equal(inspectHarnessRun(missing).passed, false);
  const corrupt = fixture();
  corrupt.rows[0].result = corrupt.rows[0].result.replace(
    "Source page",
    "Changed page",
  );
  assert.match(inspectHarnessRun(corrupt).errors.join(" "), /mismatch/);
});

test("Harness report rejects uncollected citations, edited output and failed disconnect", () => {
  const altered = fixture();
  altered.guide += "[新来源](https://example.com)";
  const report = inspectHarnessRun(altered);
  assert.equal(report.checks.guideMatchesFinalModelMessage, false);
  assert.equal(report.passed, false);
  const disconnected = fixture();
  const result = disconnected.events
    .filter((event) => event.type === "tool/result")
    .at(-1);
  result.data.message.content[0].isError = true;
  assert.equal(inspectHarnessRun(disconnected).checks.disconnected, false);
});

test("Harness report does not accept successful process exit without a completed model turn", () => {
  const incomplete = fixture();
  incomplete.events.at(-1).data.reason.kind = "aborted";
  assert.equal(inspectHarnessRun(incomplete).passed, false);
  const outputOnly = fixture();
  outputOnly.events = [];
  assert.equal(inspectHarnessRun(outputOnly).passed, false);
});
