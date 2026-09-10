#!/usr/bin/env node
//
// Emits the GitHub Actions build matrix from layer.config.json, so the runner
// and architecture mapping lives in one place.
//
//   FLAVORS="base extensions" node scripts/matrix.mjs
//
import { readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(repoRoot, 'layer.config.json'), 'utf8'));

const requested = (process.env.FLAVORS ?? 'base').trim();
const flavors = requested === 'both' ? Object.keys(config.flavors) : requested.split(/\s+/).filter(Boolean);

for (const flavor of flavors) {
  if (!config.flavors[flavor]) {
    console.error(`unknown flavor: ${flavor}`);
    process.exit(64);
  }
}

const include = flavors.flatMap((flavor) =>
  Object.entries(config.architectures).map(([architecture, arch]) => ({
    flavor,
    architecture,
    runner: arch.runner,
    layer: `${config.flavors[flavor].layerNamePrefix}-${arch.layerNameSuffix}`,
  }))
);

const matrix = JSON.stringify({ include });
console.log(matrix);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
}
