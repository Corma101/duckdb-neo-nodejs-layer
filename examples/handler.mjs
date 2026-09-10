//
// ESM handler. A layer's node_modules only lives on NODE_PATH, and Node's ESM
// resolver ignores NODE_PATH, so reach the layer through createRequire.
//
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DuckDBInstance } = require('@duckdb/node-api');

// Keep the instance outside the handler so warm invocations reuse it.
let instancePromise;

const getConnection = async () => {
  instancePromise ??= DuckDBInstance.create(':memory:', {
    // Only needed with the extensions flavor of the layer.
    extension_directory: '/opt/duckdb/extensions',
    // DuckDB writes temporary files and its home under here; /tmp is the only
    // writable path in a Lambda function.
    home_directory: '/tmp',
    temp_directory: '/tmp/duckdb',
    memory_limit: '1GB',
    threads: '2',
  });
  const instance = await instancePromise;
  return instance.connect();
};

export const handler = async (event) => {
  const connection = await getConnection();

  // Bundled with the extensions flavor; drop this line when you use the base
  // layer and only need parquet, json, icu and the core functions.
  await connection.run('LOAD httpfs');

  // Picks up the function's execution role, so no keys anywhere.
  await connection.run("CREATE OR REPLACE SECRET s3 (TYPE s3, PROVIDER credential_chain)");

  const reader = await connection.runAndReadAll(
    'SELECT count(*)::INT AS rows FROM read_parquet($uri)',
    { uri: event.uri ?? 's3://my-bucket/my-prefix/*.parquet' }
  );

  return {
    statusCode: 200,
    body: JSON.stringify(reader.getRowObjectsJson()),
  };
};
