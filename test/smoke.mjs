#!/usr/bin/env node
//
// Runs inside a Lambda base image with the layer mounted at /opt, so it
// exercises exactly what a function would: NODE_PATH resolution, the prebuilt
// libduckdb.so, and (for the extensions flavor) loading extensions from a
// read-only directory with no network access.
//
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

// A layer's node_modules is only on NODE_PATH, which the ESM resolver ignores.
// createRequire is the supported way to reach it from an ESM handler.
const require = createRequire(import.meta.url);
const { DuckDBInstance } = require('@duckdb/node-api');

const flavor = process.env.FLAVOR ?? 'base';
const expectedDuckDBVersion = process.env.EXPECTED_DUCKDB_VERSION;
const bundledExtensions = (process.env.BUNDLED_EXTENSIONS ?? '').split(/\s+/).filter(Boolean);
const staticExtensions = ['core_functions', 'icu', 'json', 'parquet'];

const config = flavor === 'extensions' ? { extension_directory: '/opt/duckdb/extensions' } : {};
const instance = await DuckDBInstance.create(':memory:', config);
const connection = await instance.connect();

const rows = async (sql) => (await connection.runAndReadAll(sql)).getRowObjectsJson();

const [{ library_version: libraryVersion }] = await rows('PRAGMA version');
console.log(`duckdb library version: ${libraryVersion}`);
if (expectedDuckDBVersion) {
  assert.equal(libraryVersion, `v${expectedDuckDBVersion}`, 'library version does not match layer.config.json');
}

const [{ n, s }] = await rows('SELECT count(*)::INT AS n, sum(i)::INT AS s FROM range(1000) t(i)');
assert.equal(Number(n), 1000);
assert.equal(Number(s), 499500);

// Parquet and JSON are statically linked, so this must work without any LOAD.
await connection.run("COPY (SELECT i, i * 2 AS double FROM range(100) t(i)) TO '/tmp/smoke.parquet' (FORMAT parquet)");
const [{ c }] = await rows("SELECT count(*)::INT AS c FROM read_parquet('/tmp/smoke.parquet')");
assert.equal(Number(c), 100);

// ICU is what makes time zones work, and it is the one people miss most.
const [{ tz }] = await rows("SELECT (TIMESTAMP '2026-01-01 12:00:00' AT TIME ZONE 'Europe/Paris')::VARCHAR AS tz");
assert.ok(tz, 'ICU time zone conversion returned nothing');

const installed = await rows(
  'SELECT extension_name, loaded, install_mode FROM duckdb_extensions() WHERE installed ORDER BY extension_name'
);
console.log('installed extensions:');
for (const row of installed) {
  console.log(`  ${row.extension_name} (loaded=${row.loaded}, mode=${row.install_mode})`);
}
for (const name of staticExtensions) {
  const row = installed.find((r) => r.extension_name === name);
  assert.ok(row?.loaded, `expected ${name} to be statically linked and loaded`);
}

if (flavor === 'extensions') {
  for (const name of bundledExtensions) {
    await connection.run(`LOAD ${name}`);
    const [row] = await rows(`SELECT loaded FROM duckdb_extensions() WHERE extension_name = '${name}'`);
    assert.ok(row?.loaded, `expected bundled extension ${name} to load from /opt/duckdb/extensions`);
    console.log(`  loaded bundled extension: ${name}`);
  }
  // httpfs registers the s3:// filesystem; check the settings it installs exist,
  // which proves the extension really initialised (no network needed).
  const [{ c: httpfsSettings }] = await rows(
    "SELECT count(*)::INT AS c FROM duckdb_settings() WHERE name IN ('s3_region', 's3_endpoint')"
  );
  assert.equal(Number(httpfsSettings), 2, 'httpfs settings are missing after LOAD');
}

console.log(`\nsmoke test passed (flavor: ${flavor}, arch: ${process.arch}, node: ${process.version})`);
