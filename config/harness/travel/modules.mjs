import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const root = resolve(import.meta.dirname, '../../..');
export async function harnessImport(name) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'runtime/harness-artifacts.json'), 'utf8'));
  const pkg = manifest.packages[name];
  if (!pkg) throw new Error(`Pinned Harness package missing: ${name}`);
  return import(pathToFileURL(resolve(root, pkg.entry)).href);
}
