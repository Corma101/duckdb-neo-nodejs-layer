//
// CommonJS handler. NODE_PATH resolution works out of the box here, so a plain
// require reaches the layer.
//
const { DuckDBInstance } = require('@duckdb/node-api');

let instancePromise;

exports.handler = async () => {
  instancePromise ??= DuckDBInstance.create(':memory:', { home_directory: '/tmp' });
  const connection = await (await instancePromise).connect();

  const reader = await connection.runAndReadAll('PRAGMA version');
  return { statusCode: 200, body: JSON.stringify(reader.getRowObjectsJson()) };
};
