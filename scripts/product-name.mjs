#!/usr/bin/env node
// Keeps the product name in one place (packages/config/product.json).
//
//   --check  fail if the name appears in code outside the allowed files,
//            or if tauri.conf.json is out of sync
//   --write  copy the name from product.json into tauri.conf.json
//
// Docs (README, CLAUDE.md, docs/) may mention the name; code may not.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const productFile = 'packages/config/product.json';
const tauriConfFile = 'apps/till/src-tauri/tauri.conf.json';
const { name } = JSON.parse(readFileSync(join(root, productFile), 'utf8'));

const mode = process.argv[2];
if (mode !== '--check' && mode !== '--write') {
  console.error('Usage: product-name.mjs --check | --write');
  process.exit(2);
}

const tauriConfPath = join(root, tauriConfFile);
const tauriConf = existsSync(tauriConfPath)
  ? JSON.parse(readFileSync(tauriConfPath, 'utf8'))
  : { productName: name };

if (mode === '--write') {
  tauriConf.productName = name;
  for (const win of tauriConf.app?.windows ?? []) win.title = name;
  writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
  console.log(`Set product name to "${name}" in ${tauriConfFile}`);
  process.exit(0);
}

const problems = [];

if (tauriConf.productName !== name) {
  problems.push(`${tauriConfFile}: productName is "${tauriConf.productName}", expected "${name}"`);
}
for (const win of tauriConf.app?.windows ?? []) {
  if (win.title !== name) {
    problems.push(`${tauriConfFile}: window title is "${win.title}", expected "${name}"`);
  }
}

const allowed = new Set([productFile, tauriConfFile, 'pnpm-lock.yaml']);
const isDoc = (file) =>
  file.startsWith('docs/') || /^(README|CLAUDE)\.md$/.test(file) || file.endsWith('.md');

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((file) => !allowed.has(file) && !isDoc(file));

const needle = name.toLowerCase();
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  if (text.includes('\u0000')) continue; // binary
  text.split('\n').forEach((line, i) => {
    if (line.toLowerCase().includes(needle)) {
      problems.push(`${file}:${i + 1}: product name in code; import it from @app/config instead`);
    }
  });
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Product name "${name}" only appears where allowed.`);
