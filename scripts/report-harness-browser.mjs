import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { inspectHarnessRun } from "./lib/harness-browser-report.mjs";

const directory = process.argv[2];
if (!directory)
  throw new Error(
    "Usage: node scripts/report-harness-browser.mjs data/harness-runs/RUN_ID",
  );
const runDir = resolve(directory);
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name === "session.v2.jsonl"
        ? [join(dir, entry.name)]
        : [],
  );
const transcripts = walk(join(runDir, "sessions"));
if (transcripts.length !== 1)
  throw new Error("Expected one durable Harness session.");
const events = readFileSync(transcripts[0], "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const db = new Database(join(runDir, "browser/travel.db"), { readonly: true });
let rows;
try {
  rows = db.prepare("SELECT id,request_id,result FROM browser_queries").all();
} finally {
  db.close();
}
const report = inspectHarnessRun({
  run: JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")),
  events,
  rows,
  guide: readFileSync(join(runDir, "florence-guide.md"), "utf8"),
});
writeFileSync(
  join(runDir, "verification.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
