import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "vendor/deepseek-harness");
const args = process.argv.slice(2);
const codingPlan = args.includes("--coding-plan-diagnostic");
const help = args.includes("--help");
if (
  args.some(
    (arg) =>
      !["--coding-plan-diagnostic", "--help", "--prepare-only"].includes(arg),
  )
) {
  throw new Error("Unknown option. Use --help.");
}
if (help) {
  console.log(
    "Usage: npm run harness:florence -- [--coding-plan-diagnostic] [--prepare-only]\nDefault: ordinary ZHIPU_API_KEY. Explicit diagnostic: separate ZHIPU_CODING_API_KEY and Coding Plan endpoint.\nEach invocation creates an isolated data/harness-runs directory. Maximum wall time: 10 minutes.",
  );
  process.exit(0);
}
const fileEnv = existsSync(join(root, ".env"))
  ? parseEnv(readFileSync(join(root, ".env"), "utf8"))
  : {};
const value = (key) => process.env[key] || fileEnv[key];
const credential = codingPlan ? "ZHIPU_CODING_API_KEY" : "ZHIPU_API_KEY";
const model =
  value(codingPlan ? "ZHIPU_CODING_MODEL" : "ZHIPU_MODEL") || "glm-5.2";
if (!value(credential) && !args.includes("--prepare-only"))
  throw new Error(`Missing ${credential}; no request sent.`);
if (!existsSync(join(root, "dist/server/agent/browser/main.js")))
  throw new Error("Run npm run build first.");
if (!existsSync(join(harness, "node_modules/tsx/package.json")))
  throw new Error(
    "Install the pinned Harness workspace with pnpm install --frozen-lockfile first.",
  );
const pinnedRevision = JSON.parse(
  readFileSync(join(root, "vendor/deepseek-harness.lock.json"), "utf8"),
).revision;
if (
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: harness,
    encoding: "utf8",
  }).trim() !== pinnedRevision
)
  throw new Error("Harness checkout does not match the pinned revision.");

process.umask(0o077);
const runId =
  new Date().toISOString().replace(/[:.]/g, "-") +
  "-" +
  randomUUID().slice(0, 8);
const runDir = join(root, "data/harness-runs", runId);
const profile = join(runDir, "home/profiles/travel-glm");
mkdirSync(profile, { recursive: true, mode: 0o700 });
copyFileSync(
  join(root, "config/harness/travel-glm/cordis.patch.yml"),
  join(profile, "cordis.patch.yml"),
);
const patch = readFileSync(join(profile, "cordis.patch.yml"), "utf8");
const workspaceManifests = [
  ...readdirSync(join(harness, "vendor"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(harness, "vendor", entry.name, "package.json")),
  ...readdirSync(join(harness, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((group) =>
      readdirSync(join(harness, "packages", group.name), {
        withFileTypes: true,
      })
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          join(harness, "packages", group.name, entry.name, "package.json"),
        ),
    ),
];
const versions = new Map(
  workspaceManifests.filter(existsSync).map((filename) => {
    const item = JSON.parse(readFileSync(filename, "utf8"));
    return [item.name, item.version];
  }),
);
const dependencies = Object.fromEntries(
  [...patch.matchAll(/name: '(@deepseek-ai\/[^']+)'/g)].map((match) => {
    const name = match[1].split("/").slice(0, 2).join("/");
    if (!versions.has(name))
      throw new Error(`Profile plugin not found in pinned workspace: ${name}`);
    return [name, versions.get(name)];
  }),
);
// The launcher resolves these packages from its pinned installation closure.
writeFileSync(
  join(profile, "package.json"),
  JSON.stringify(
    {
      name: "travel-glm-profile",
      private: true,
      type: "module",
      dependencies,
      dsh: { profile: { bundles: [], patchReload: "startup" } },
    },
    null,
    2,
  ) + "\n",
);
const prompt =
  readFileSync(
    join(root, "config/harness/travel-glm/florence-prompt.txt"),
    "utf8",
  ) + `\n本次查阅日期：${new Date().toISOString().slice(0, 10)}。`;
writeFileSync(join(runDir, "prompt.txt"), prompt);
const baseURL = codingPlan
  ? "https://open.bigmodel.cn/api/coding/paas/v4"
  : "https://open.bigmodel.cn/api/paas/v4";
const meta = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  harnessCommit: JSON.parse(
    readFileSync(join(root, "vendor/deepseek-harness.lock.json"), "utf8"),
  ).revision,
  requestedModel: model,
  baseURL,
  credentialName: credential,
  scope: codingPlan
    ? "User-requested isolated Coding Plan development verification; not application runtime configuration."
    : "GLM browser integration verification",
  wallTimeoutMs: 600000,
  browserQueryBudget: {
    maximum: 10,
    enforcement: "model instruction; wall timeout is enforced by runner",
  },
  runDir,
};
writeFileSync(join(runDir, "run.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(`Harness run: ${runDir}`);
if (args.includes("--prepare-only")) process.exit(0);

// Only the chosen credential enters the Harness process. The MCP bridge scrubs secret env names.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/KEY|PASSWORD|SECRET|TOKEN/i.test(key) &&
      !/^(DSH_|TRAVEL_|BROWSER_AUTO_CONNECT$|NODE_OPTIONS$)/.test(key),
  ),
);
Object.assign(env, {
  TRAVEL_GLM_API_KEY: value(credential),
  TRAVEL_GLM_MODEL: model,
  TRAVEL_GLM_BASE_URL: baseURL,
  TRAVEL_PROJECT_ROOT: root,
  TRAVEL_HARNESS_RUN_DIR: runDir,
  DSH_HOME: join(runDir, "home"),
  DSH_TELEMETRY_DISABLED: "1",
  TSX_TSCONFIG_PATH: join(harness, "tsconfig.json"),
});
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx/esm",
    "apps/cli/src/bin.ts",
    "--profile",
    "travel-glm",
    prompt,
  ],
  { cwd: harness, env, stdio: ["ignore", "pipe", "pipe"] },
);
let stdout = "";
let stderr = "";
child.stdout.on("data", (bytes) => {
  stdout += bytes.toString();
});
child.stderr.on("data", (bytes) => {
  stderr += bytes.toString();
});
let interrupted = false;
let killTimer;
const stop = () => {
  interrupted = true;
  child.kill("SIGTERM");
  killTimer ??= setTimeout(() => child.kill("SIGKILL"), 10000);
};
const timer = setTimeout(stop, meta.wallTimeoutMs);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const outcome = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolveExit({ code, signal }));
});
clearTimeout(timer);
clearTimeout(killTimer);
process.off("SIGINT", stop);
process.off("SIGTERM", stop);
const scrub = (text) => text.replaceAll(value(credential), "[REDACTED]");
writeFileSync(join(runDir, "stdout.txt"), scrub(stdout));
writeFileSync(join(runDir, "stderr.txt"), scrub(stderr));
const finished = {
  ...meta,
  finishedAt: new Date().toISOString(),
  ...outcome,
  interrupted,
};
writeFileSync(
  join(runDir, "run.json"),
  JSON.stringify(finished, null, 2) + "\n",
);
if (outcome.code === 0 && stdout.trim()) {
  writeFileSync(join(runDir, "florence-guide.md"), scrub(stdout.trim()) + "\n");
  console.log(`GLM output: ${join(runDir, "florence-guide.md")}`);
  try {
    execFileSync(
      process.execPath,
      [join(root, "scripts/report-harness-browser.mjs"), runDir],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    console.log(
      `Browser/Harness evidence verified: ${join(runDir, "verification.json")}`,
    );
  } catch {
    console.error(
      `Output saved, but browser evidence verification failed. Inspect ${join(runDir, "verification.json")}.`,
    );
    process.exitCode = 1;
  }
} else {
  console.error(
    `Harness did not complete. Exit=${outcome.code}; inspect ${join(runDir, "stderr.txt")}`,
  );
  process.exitCode = 1;
}
// Session transcripts include public webpage excerpts and stay in the ignored private run directory.
const protect = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) protect(filename);
    else if (entry.isFile()) chmodSync(filename, 0o600);
  }
};
protect(runDir);
