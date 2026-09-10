#!/usr/bin/env node
//
// Records the outcome of one publish run into arns/<layer-name>.json, keeping a
// version history so the README tables can be regenerated from committed state.
//
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
for (const required of ['layer-name', 'architecture', 'flavor', 'duckdb-version', 'node-api-version', 'results']) {
  if (!args.has(required)) {
    console.error(`missing --${required}`);
    process.exit(64);
  }
}

const regions = {};
for (const line of readFileSync(args.get('results'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const [region, layerVersion, arn] = line.split('\t');
  regions[region] = { layerVersion: Number(layerVersion), arn };
}

const layerName = args.get('layer-name');
const statePath = join(repoRoot, 'arns', `${layerName}.json`);
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { layerName, architecture: args.get('architecture'), flavor: args.get('flavor'), history: [] };

const publishedAt = new Date().toISOString();
const layerVersions = [...new Set(Object.values(regions).map((r) => r.layerVersion))].sort((a, b) => a - b);

state.current = {
  duckdbVersion: args.get('duckdb-version'),
  nodeApiVersion: args.get('node-api-version'),
  publishedAt,
  layerVersions,
  regions: Object.fromEntries(Object.entries(regions).sort(([a], [b]) => a.localeCompare(b))),
};
state.history = [
  ...state.history.filter((entry) => entry.nodeApiVersion !== args.get('node-api-version')),
  {
    layerVersions,
    duckdbVersion: args.get('duckdb-version'),
    nodeApiVersion: args.get('node-api-version'),
    publishedAt,
  },
].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(`==> recorded ${Object.keys(regions).length} region(s) in arns/${layerName}.json`);
