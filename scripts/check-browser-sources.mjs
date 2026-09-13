import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../dist/server/storage/database.js";
import { acquireLock } from "../dist/server/storage/runtime-lock.js";
import { BrowserService } from "../dist/server/agent/browser/service.js";
import { browserOptions } from "../dist/server/agent/browser/config.js";

const directory = resolve(
  process.env.BROWSER_DATA_DIR || "data/browser-validation",
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const release = acquireLock(directory);
const db = openDatabase(join(directory, "travel.db"));
const service = new BrowserService(db, {
  ...browserOptions(directory),
  headless: process.env.BROWSER_HEADLESS !== "0",
  timeoutMs: 30000,
});
const queries = [
  {
    source: "uffizi",
    action: "read",
    url: "https://www.uffizi.it/en/the-uffizi",
  },
  { source: "wikipedia", action: "search", query: "Uffizi" },
  {
    source: "reddit",
    action: "read",
    url: "https://www.reddit.com/r/florence/comments/1qvvb74/a_good_uffizi_strategy/",
  },
  { source: "xiaohongshu", action: "search", query: "佛罗伦萨 乌菲兹" },
  {
    source: "tripadvisor",
    action: "read",
    url: "https://www.tripadvisor.com/Attraction_Review-g187895-d191153-Reviews-Le_Gallerie_Degli_Uffizi-Florence_Tuscany.html",
  },
];
const selected = process.argv[2];
const results = [];
try {
  for (const entry of queries.filter(
    (q) => !selected || q.source === selected,
  )) {
    const request = {
      ...entry,
      requestId: randomUUID(),
      context: {
        destination: "Florence",
        purpose: "Browser tool capability validation",
        conditions: {},
      },
    };
    if (request.action === "read") delete request.source;
    const response = await service.execute("local", request);
    const row = {
      source: entry.source,
      queryId: response.queryId,
      status: response.status,
      title: response.data?.title,
      url: response.data?.url || entry.url,
      textCharacters: response.data?.text.length || 0,
      counts: response.data?.counts,
      durationMs: response.durationMs,
      usage: response.usage,
      missing: response.missing,
      message: response.message,
    };
    if (entry.source === "uffizi" && response.data) {
      const shot = await service.execute("local", {
        action: "screenshot",
        pageId: response.data.pageId,
        requestId: randomUUID(),
      });
      row.screenshotStatus = shot.status;
      if (shot.artifact) {
        const artifact = service.store.artifact("local", shot.artifact.id);
        mkdirSync(".cache/browser-qa", { recursive: true });
        writeFileSync(".cache/browser-qa/uffizi.jpg", artifact.bytes, {
          mode: 0o600,
        });
        row.screenshotSha256 = artifact.sha256;
      }
    }
    results.push(row);
    console.log(JSON.stringify(row));
  }
  const report = {
    checkedAt: new Date().toISOString(),
    channel: "chrome-devtools-mcp@1.8.0, dedicated Chrome profile",
    mode: process.env.BROWSER_HEADLESS === "0" ? "headed" : "headless",
    scope:
      "Finite public-page samples. No model or paid content API calls. Does not verify sustained access, complete reviews, image interpretation, date-specific facts or production access permission.",
    evidenceDatabase:
      "BROWSER_DATA_DIR/travel.db (default data/browser-validation/travel.db)",
    results,
  };
  const suffix = selected ? `-${selected}` : "";
  writeFileSync(
    `docs/qa/browser-sources${suffix}.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
} finally {
  await service.close();
  db.close();
  release();
}
