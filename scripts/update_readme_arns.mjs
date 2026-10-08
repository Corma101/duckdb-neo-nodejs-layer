#!/usr/bin/env node
//
// Regenerates the ARN tables in README.md from the committed state in arns/.
// Everything between the markers is generated; edit the scripts, not the tables.
//
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const arnsDir = join(repoRoot, 'arns');
const readmePath = join(repoRoot, 'README.md');
const BEGIN = '<!-- BEGIN:ARNS -->';
const END = '<!-- END:ARNS -->';

const config = JSON.parse(readFileSync(join(repoRoot, 'layer.config.json'), 'utf8'));

const flavorTitles = {
  base: 'Base layers',
  extensions: 'Layers with bundled extensions',
};

const states = existsSync(arnsDir)
  ? readdirSync(arnsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(arnsDir, f), 'utf8')))
      .filter((s) => s.current)
      .sort((a, b) => `${a.flavor}${a.architecture}`.localeCompare(`${b.flavor}${b.architecture}`))
  : [];

const sections = [];
if (states.length === 0) {
  sections.push(
    '_No layer has been published yet. Run the **Release layers** workflow, and this section will be filled in automatically._'
  );
} else {
  for (const flavor of Object.keys(config.flavors)) {
    const forFlavor = states.filter((s) => s.flavor === flavor);
    if (forFlavor.length === 0) continue;
    sections.push(`### ${flavorTitles[flavor] ?? flavor}\n`);

    for (const state of forFlavor) {
      const { layerName, architecture, current, history } = state;
      sections.push(`#### \`${layerName}\` (${architecture})\n`);
      sections.push(
        `Latest: **DuckDB v${current.duckdbVersion}** (\`@duckdb/node-api@${current.nodeApiVersion}\`), ` +
          `published ${current.publishedAt.slice(0, 10)}.\n`
      );

      sections.push('| Layer version | DuckDB version | Node Neo release |');
      sections.push('|---|---|---|');
      for (const entry of [...history].reverse()) {
        sections.push(
          `| ${entry.layerVersions.join(', ')} | v${entry.duckdbVersion} | \`${entry.nodeApiVersion}\` |`
        );
      }
      sections.push('');

      // The versions are per region on purpose: a partial release leaves regions
      // behind, and a consumer pinning one ARN needs that row to be self-contained.
      sections.push('| Region | Layer ARN | DuckDB | Node Neo release |');
      sections.push('|---|---|---|---|');
      for (const [region, entry] of Object.entries(current.regions)) {
        const duckdb = entry.duckdbVersion ?? current.duckdbVersion;
        const nodeApi = entry.nodeApiVersion ?? current.nodeApiVersion;
        sections.push(`| ${region} | \`${entry.arn}\` | v${duckdb} | \`${nodeApi}\` |`);
      }
      sections.push('');
    }
  }
}

const readme = readFileSync(readmePath, 'utf8');
const start = readme.indexOf(BEGIN);
const end = readme.indexOf(END);
if (start === -1 || end === -1) {
  console.error(`README.md is missing the ${BEGIN} / ${END} markers`);
  process.exit(1);
}

const updated = `${readme.slice(0, start + BEGIN.length)}\n\n${sections.join('\n')}\n${readme.slice(end)}`;
writeFileSync(readmePath, updated);
console.log(`==> README.md ARN tables updated from ${states.length} layer state file(s)`);
