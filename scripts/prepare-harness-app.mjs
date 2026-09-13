import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '..');
const harness = resolve(root, 'vendor/deepseek-harness');
const expected = JSON.parse(readFileSync(resolve(root, 'vendor/deepseek-harness.lock.json'), 'utf8'));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: harness, encoding: 'utf8' });
if (revision.status || revision.stdout.trim() !== 'd347e703908d0406b7a7ef80e3a0e594d86b2215') throw new Error('Harness revision does not match the reviewed pin');
if (process.argv.includes('--build')) {
  const build = spawnSync('npm', ['run', 'build:lib:host'], { cwd: harness, stdio: 'inherit' });
  if (build.status) process.exit(build.status);
}
const manifests = [
  ...readdirSync(join(harness, 'vendor'), { withFileTypes: true }).filter(x => x.isDirectory()).map(x => join(harness, 'vendor', x.name, 'package.json')),
  ...readdirSync(join(harness, 'packages'), { withFileTypes: true }).filter(x => x.isDirectory()).flatMap(g => readdirSync(join(harness, 'packages', g.name), { withFileTypes: true }).filter(x => x.isDirectory()).map(x => join(harness, 'packages', g.name, x.name, 'package.json'))),
];
const packages = {};
for (const file of manifests.filter(existsSync)) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const exp = pkg.exports?.['.'];
  const rel = typeof exp === 'string' ? exp : exp?.default;
  if (!rel) continue;
  const entry = resolve(file, '..', rel);
  if (!existsSync(entry)) continue;
  packages[pkg.name] = { version: pkg.version, entry, sha256: createHash('sha256').update(readFileSync(entry)).digest('hex') };
}
for (const name of ['@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-llm-pi-ai']) if (!packages[name]) throw new Error(`Missing built artifact ${name}; run npm run harness:prepare`);
mkdirSync(resolve(root, 'runtime'), { recursive: true });
writeFileSync(resolve(root, 'runtime/harness-artifacts.json'), JSON.stringify({ revision: revision.stdout.trim(), packages: Object.fromEntries(Object.entries(packages).map(([name,pkg]) => [name,{...pkg,entry:relative(root,pkg.entry)}])) }, null, 2) + '\n');
const session = await import(pathToFileURL(packages['@deepseek-ai/dsh-session'].entry).href);
writeFileSync(resolve(root, 'src/shared/harness-event-types.json'), JSON.stringify({ revision: revision.stdout.trim(), sessionFormat: session.SESSION_FORMAT_VERSION, events: [...session.KNOWN_SESSION_EVENT_TYPES].sort() }, null, 2) + '\n');
console.log(`Harness host artifacts ready: ${Object.keys(packages).length} package entries, Session format ${session.SESSION_FORMAT_VERSION}`);

const { build } = await import('esbuild');
await build({stdin:{contents:`export { validateStoredEvents } from ${JSON.stringify(packages['@deepseek-ai/dsh-session-persistence'].entry)};`,resolveDir:root,sourcefile:'harness-validator.mjs'},bundle:true,platform:'node',format:'cjs',alias:Object.fromEntries(Object.entries(packages).map(([name,pkg])=>[name,pkg.entry])),define:{'import.meta.url':'__harnessUrl'},banner:{js:"var __harnessUrl = require('node:url').pathToFileURL(__filename).href;"},outfile:resolve(root,'runtime/harness-validator.cjs')});
