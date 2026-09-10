#!/usr/bin/env node
//
// Compares layer.config.json with the latest @duckdb/node-api release on npm.
// With --write it updates the config so CI can open a bump PR.
//
//   node scripts/check_upstream.mjs [--write]
//
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repoRoot, 'layer.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const response = await fetch('https://registry.npmjs.org/@duckdb/node-api/latest');
if (!response.ok) {
  console.error(`npm registry returned ${response.status}`);
  process.exit(1);
}
const { version: latest } = await response.json();

// Node Neo releases look like 1.5.5-r.4: the DuckDB version, then a release
// counter for the bindings themselves.
const duckdbVersion = latest.replace(/-r\.\d+$/, '');
const current = config.nodeApiVersion;
const outdated = latest !== current;

console.log(`current: ${current}`);
console.log(`latest:  ${latest}${outdated ? '  <-- new release' : '  (up to date)'}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `outdated=${outdated}\ncurrent=${current}\nlatest=${latest}\nduckdb_version=${duckdbVersion}\n`
  );
}

if (outdated && process.argv.includes('--write')) {
  const updated = readFileSync(configPath, 'utf8')
    .replace(/("nodeApiVersion":\s*)"[^"]+"/, `$1"${latest}"`)
    .replace(/("duckdbVersion":\s*)"[^"]+"/, `$1"${duckdbVersion}"`);
  writeFileSync(configPath, updated);
  console.log(`==> layer.config.json bumped to ${latest} (DuckDB v${duckdbVersion})`);
}

process.exit(0);
