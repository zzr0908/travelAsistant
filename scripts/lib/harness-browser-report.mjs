import { createHash } from "node:crypto";

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** Cross-check durable Harness tool results against the browser evidence database. */
export function inspectHarnessRun({ run, events, rows, guide }) {
  const calls = events.filter((event) => event.type === "tool/call");
  const results = new Map(
    events
      .filter((event) => event.type === "tool/result")
      .map((event) => [event.data.message.source.callId, event]),
  );
  const messages = events.filter((event) => event.type === "assistant/message");
  const queries = [];
  const errors = [];
  const successes = [];
  const observedTools = new Set();
  for (const event of calls) {
    const { name, callId, arguments: raw } = event.data;
    observedTools.add(name);
    const result = results.get(callId);
    if (!result) {
      errors.push(`Missing tool result: ${callId}`);
      continue;
    }
    if (name !== "mcp__travel__travel_browser_query") continue;
    const input = JSON.parse(raw).request;
    const blocks = result.data.message.content.flatMap((block) =>
      block.type === "tool-result" ? block.content : [],
    );
    const text = blocks.find((block) => block.type === "text")?.text;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      errors.push(`Invalid browser result: ${callId}`);
      continue;
    }
    queries.push({
      callId,
      requestId: input.requestId,
      action: input.action,
      queryId: value.queryId ?? null,
      status: value.status ?? "mcp_error",
      url: value.data?.url ?? input.url ?? null,
      evidenceIds: value.evidenceIds ?? [],
      missing: value.missing ?? [],
      durationMs: value.durationMs ?? null,
    });
    if (
      !value.data?.text ||
      !value.data.evidenceId ||
      !["ok", "partial"].includes(value.status)
    )
      continue;
    const stored = rows.find(
      (row) => row.id === value.queryId && row.request_id === input.requestId,
    );
    if (!stored?.result) {
      errors.push(`Evidence is absent from SQLite: ${value.queryId}`);
      continue;
    }
    const durable =
      typeof stored.result === "string"
        ? JSON.parse(stored.result)
        : stored.result;
    if (JSON.stringify(durable) !== JSON.stringify(value))
      errors.push(`Harness/SQLite result mismatch: ${value.queryId}`);
    if (hash(value.data.text) !== value.data.textHash)
      errors.push(`Text hash mismatch: ${value.queryId}`);
    if (!value.evidenceIds.includes(value.data.evidenceId))
      errors.push(`Missing evidence association: ${value.queryId}`);
    successes.push({
      queryId: value.queryId,
      evidenceId: value.data.evidenceId,
      action: input.action,
      url: value.data.url,
      title: value.data.title,
      textChars: value.data.text.length,
      sha256: value.data.textHash,
      retrievedAt: value.retrievedAt,
      textRange: value.data.textRange,
      missing: value.missing,
    });
  }
  const last = messages.at(-1);
  const finalText =
    last?.data.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("") ?? "";
  const successfulUrls = new Set(successes.map((item) => item.url));
  const disconnected = calls.some((event) => {
    if (event.data.name !== "mcp__travel__travel_browser_disconnect")
      return false;
    const result = results.get(event.data.callId);
    const toolBlocks =
      result?.data.message.content.filter(
        (block) => block.type === "tool-result",
      ) ?? [];
    return toolBlocks.some(
      (block) =>
        !block.isError &&
        block.content.some((item) => {
          if (item.type !== "text") return false;
          try {
            return JSON.parse(item.text).disconnected === true;
          } catch {
            return false;
          }
        }),
    );
  });
  const citedUrls = [...guide.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map(
    (match) => match[1],
  );
  const uncitedEvidence = [...new Set(citedUrls)].filter(
    (url) => !successfulUrls.has(url),
  );
  if (uncitedEvidence.length)
    errors.push(
      `Guide cites pages without successful browser evidence: ${uncitedEvidence.join(", ")}`,
    );
  const checks = {
    processCompleted: run.code === 0 && !run.interrupted,
    turnCompleted:
      events.findLast((event) => event.type === "turn/end")?.data.reason
        ?.kind === "completed",
    glmProducedMessages:
      messages.length > 0 &&
      messages.every(
        (event) => event.data.message.source?.provider === "travel-glm",
      ),
    onlyTravelBrowserTools:
      calls.length > 0 &&
      calls.every((event) =>
        event.data.name.startsWith("mcp__travel__travel_browser_"),
      ),
    statusCalled: observedTools.has("mcp__travel__travel_browser_status"),
    twoDistinctPagesRead: successfulUrls.size >= 2,
    followupInteraction: successes.some((item) =>
      ["capture", "scroll", "follow"].includes(item.action),
    ),
    disconnected,
    guideMatchesFinalModelMessage:
      finalText.trim() === guide.trim() && guide.trim().length >= 300,
    twoEvidenceLinksCited:
      new Set(citedUrls.filter((url) => successfulUrls.has(url))).size >= 2,
    evidenceMatchesDatabase: errors.length === 0,
  };
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  let usageMessages = 0;
  for (const event of messages) {
    if (event.data.usage) {
      usageMessages++;
      for (const key of Object.keys(usage))
        usage[key] += event.data.usage[key] ?? 0;
    }
  }
  return {
    schemaVersion: 1,
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    harnessCommit: run.harnessCommit,
    requestedModel: run.requestedModel,
    responseModels: [
      ...new Set(
        messages
          .map(
            (event) =>
              event.data.message.source?.replayState?.response?.responseModel,
          )
          .filter(Boolean),
      ),
    ],
    modelRequestsWithMessages: messages.length,
    failedAttempts: events.filter((event) => event.type === "assistant/attempt")
      .length,
    usage: {
      ...usage,
      reportedMessages: usageMessages,
      cost: null,
      note: "Harness/pi-ai accounting; inputTokens excludes cacheReadTokens. Cost and subscription deduction were not measured.",
    },
    toolCalls: calls.length,
    queries,
    evidence: successes,
    checks,
    errors,
    passed: Object.values(checks).every(Boolean),
    guide: { sha256: hash(guide), characters: guide.length, citedUrls },
    limitations: [
      "An isolated development run, not integration into the application research UI.",
      "Website content is source evidence; itinerary ordering remains a model recommendation.",
      "No image interpretation, community login, route timing or ticket inventory validation.",
    ],
  };
}
