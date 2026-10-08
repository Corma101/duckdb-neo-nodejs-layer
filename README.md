# duckdb-neo-nodejs-layer

Public AWS Lambda layers packaging [DuckDB](https://duckdb.org/) for Node.js, built on the
[Node Neo](https://duckdb.org/docs/current/clients/node_neo/overview) client
([`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api) +
[`@duckdb/node-bindings`](https://www.npmjs.com/package/@duckdb/node-bindings)).

This is a rework of [tobilg/duckdb-nodejs-layer](https://github.com/tobilg/duckdb-nodejs-layer), which packages the
older `duckdb` npm package. Two things change as a result:

- **The API is different.** Node Neo is promise-first and typed; there is no `Database`/`connect(cb)` callback API.
  See [the client docs](https://duckdb.org/docs/current/clients/node_neo/overview) for the surface.
- **There is nothing to compile.** `@duckdb/node-bindings-linux-{x64,arm64}` ship a prebuilt `libduckdb.so`, so the
  build is an `npm install` pinned to a target platform, then a `zip`. No Docker image, no CMake, no QEMU.

## Usage

Add one layer ARN to your function and use `@duckdb/node-api` as if it were a normal dependency. The ARNs follow:

```text
arn:aws:lambda:$REGION:$ACCOUNT_ID:layer:duckdb-neo-nodejs-$ARCHITECTURE:$VERSION
```

where `$ARCHITECTURE` is `x86` or `arm64`. Pick the row you need from the [ARN tables](#layer-arns) below.

### Handler code

The layer's `node_modules` lands at `/opt/nodejs/node_modules`, which Lambda puts on `NODE_PATH`. CommonJS handlers
resolve it with a plain `require`:

```javascript
const { DuckDBInstance } = require('@duckdb/node-api');

const instance = await DuckDBInstance.create(':memory:', { home_directory: '/tmp' });
const connection = await instance.connect();

const reader = await connection.runAndReadAll('PRAGMA version');
console.log(reader.getRowObjectsJson()); // [{ library_version: 'v1.5.5', ... }]
```

**ESM handlers need `createRequire`.** Node's ESM resolver ignores `NODE_PATH`, so a bare `import` of a package that
only exists in a layer fails at runtime. `@duckdb/node-api` is CommonJS, so this is a one-liner:

```javascript
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DuckDBInstance } = require('@duckdb/node-api');
```

Full examples: [`examples/handler.mjs`](examples/handler.mjs), [`examples/handler.cjs`](examples/handler.cjs),
[`examples/serverless.yml`](examples/serverless.yml).

### Bundlers

Keep DuckDB out of your bundle — it is a native addon next to a 70 MB shared library, and the layer already carries
both. With esbuild (Serverless Framework, SST, AWS CDK's `NodejsFunction`, or your own build):

```javascript
external: ['@duckdb/node-api', '@duckdb/node-bindings']
```

Installing `@duckdb/node-api` as a local `devDependency` is still the right move: you get types and can run the same
code on your machine, where npm picks the darwin or win32 bindings instead.

### Writable paths and the home directory

A Lambda filesystem is read-only apart from `/tmp`, and DuckDB wants somewhere to put its home directory, temp files
and spilled data. Set them explicitly:

```javascript
await DuckDBInstance.create(':memory:', {
  home_directory: '/tmp',
  temp_directory: '/tmp/duckdb',
  memory_limit: '1GB',
});
```

## What is in the layer

| Path in the function | Contents |
|---|---|
| `/opt/nodejs/node_modules/@duckdb/node-api` | The client API |
| `/opt/nodejs/node_modules/@duckdb/node-bindings` | The loader (picks the platform package below) |
| `/opt/nodejs/node_modules/@duckdb/node-bindings-linux-{x64,arm64}` | `duckdb.node` + `libduckdb.so` |
| `/opt/duckdb/extensions/` | Bundled extensions — **extensions flavor only** |

Only the bindings for the layer's own architecture are shipped; the darwin, win32 and musl packages are pruned at
build time. That puts a layer at roughly **23 MB zipped / 69 MB unzipped** (base) and **36 MB / 106 MB**
(extensions) — inside Lambda's 50 MB per-layer upload limit, and leaving room under the 250 MB unzipped budget.

### Extensions

These are statically linked into `libduckdb.so` and available with no `LOAD` and no network:

`core_functions`, `icu` (time zones, collations), `json`, `parquet`, `autocomplete`.

**`httpfs` is not among them** — unlike the old `duckdb` package's static build. On its own, DuckDB would autoload it
from `extensions.duckdb.org` on first use, which needs egress and a writable extension directory: fine for a plain
function that sets `home_directory: '/tmp'`, useless inside a VPC without a NAT or an S3 endpoint, and a cold-start
tax either way.

That is what the **extensions flavor** is for. It bundles signed extensions at
`/opt/duckdb/extensions/v$DUCKDB_VERSION/$PLATFORM/`, and DuckDB loads them straight from that read-only path:

```javascript
const instance = await DuckDBInstance.create(':memory:', {
  extension_directory: '/opt/duckdb/extensions',
});
const connection = await instance.connect();
await connection.run('LOAD httpfs');
```

Bundled extensions are listed in [`layer.config.json`](layer.config.json) (`httpfs` and `aws` today). `aws` is what
turns `CREATE SECRET (TYPE s3, PROVIDER credential_chain)` into the function's execution role, so you never put keys
in an environment variable.

## Layer ARNs

<!-- BEGIN:ARNS -->

_No layer has been published yet. Run the **Release layers** workflow, and this section will be filled in automatically._
<!-- END:ARNS -->

The tables above are generated from the state committed under [`arns/`](arns) by the release workflow — edit
[`scripts/update_readme_arns.mjs`](scripts/update_readme_arns.mjs), never the tables themselves.

## Building locally

Requirements: Node.js 22+ (npm 10.2+ for the `--os`/`--cpu`/`--libc` flags), `zip`, `unzip`, and Docker for the smoke
test.

```bash
# base flavor, x86_64 -> release/duckdb-neo-layer-base-x86_64.zip
scripts/build_layer.sh x86_64

# extensions flavor, arm64
FLAVOR=extensions scripts/build_layer.sh arm64

# run test/smoke.mjs in a Lambda base image, with the layer at /opt and no network
scripts/smoke_test.sh x86_64
```

The smoke test is the interesting one: it mounts the built layer read-only at `/opt` in
`public.ecr.aws/lambda/nodejs:22` with `--network none`, then asserts the library version, a parquet round trip, ICU
time zones, and — for the extensions flavor — that every bundled extension loads from the read-only directory. If it
passes offline, it will pass in a VPC.

Cross-architecture builds work anywhere (npm just downloads a different tarball), but the smoke test needs the
matching platform, so CI runs each architecture on its own native runner.

## Publishing

Publishing is manual, through the **Release layers** workflow (`workflow_dispatch`): pick the flavors, optionally
narrow the regions, and untick *publish* for a build-only dry run. The workflow builds and smoke-tests every
architecture, then publishes each layer in its own job — one assumed role per layer, since four layers uploading
23–36 MB across every region in sequence outlives a one-hour session. Each job grants `lambda:GetLayerVersion` to
`*` so the layer is public, and a final job commits the resulting ARNs and regenerated README tables.

That last job runs even when part of the matrix fails, and the publish script writes its state file on the way out,
so whatever reached AWS is recorded and discoverable. A half-published release still has an ARN table; for a public
repository, an ARN nobody can copy is barely a release at all.

Regions the account has not opted into are reported and skipped rather than failing the run.

### AWS setup

Layers are published from an AWS account dedicated to public artifacts, not from an application account. The reason
is permanence: the account ID is part of every public layer ARN, so whichever account publishes a layer is the one
every consumer references for as long as that layer exists. Moving later means republishing under new ARNs and
asking everyone to update.

The `publish` job authenticates through GitHub's OIDC provider, so there are no long-lived keys anywhere.
[`infra/github-oidc-role.yaml`](infra/github-oidc-role.yaml) creates both halves — the account's OIDC provider and a
role that can do three things on layers named `duckdb-neo-*` and nothing else. Deploy it once, with admin
credentials on the publishing account:

```bash
aws cloudformation deploy --region eu-west-3 --stack-name duckdb-neo-layer-publisher --template-file infra/github-oidc-role.yaml --capabilities CAPABILITY_NAMED_IAM
```

Pass `--parameter-overrides CreateOIDCProvider=false` if the account already has a
`token.actions.githubusercontent.com` provider — there can only be one per account. IAM is global, so the stack's
region is cosmetic.

One trap worth knowing about: repositories created after 2026-07-15 use GitHub's **immutable subject claims**, so
the token's `sub` pins the owner and repository by numeric ID — `repo:OWNER@138037078/REPO@1364532949:ref:...`
rather than `repo:OWNER/REPO:ref:...`. A trust policy written the old way is silently never matched, and the run
fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity` before publishing anything. Read the exact
value for a repository with:

```bash
gh api repos/Corma101/duckdb-neo-nodejs-layer/actions/oidc/customization/sub --jq .sub_claim_prefix
```

and pass it as the `SubjectPrefix` parameter.

Then point the repository at the role from the stack's `RoleArn` output:

```bash
gh variable set AWS_ROLE_ARN --repo Corma101/duckdb-neo-nodejs-layer --body "<RoleArn>"
```

A note on coverage: roughly half of AWS regions are opt-in and disabled by default, so a fresh account publishes to
about 17 of them. The publish script reports and skips the rest rather than failing. Enable the ones you want under
**Account → Regions** in the publishing account, then run the release again.

To publish from a laptop instead, export credentials and run:

```bash
FLAVOR=base REGIONS="eu-west-1 eu-west-3" scripts/publish_layer.sh x86_64
```

## Keeping up with DuckDB

[`check-upstream.yml`](.github/workflows/check-upstream.yml) runs weekly, compares
[`layer.config.json`](layer.config.json) with the latest `@duckdb/node-api` on npm, and opens a bump PR when they
differ. CI builds and smoke-tests the PR; merging it and running **Release layers** is the whole upgrade.

Node Neo versions look like `1.5.5-r.4`: the DuckDB version, then a release counter for the bindings. The layer
version in the tables above is Lambda's own counter and unrelated to either.

## Credits

The packaging approach, the all-regions publishing script and the public-layer idea come from
[tobilg/duckdb-nodejs-layer](https://github.com/tobilg/duckdb-nodejs-layer) (MIT). DuckDB and its Node clients are
built by [DuckDB Labs](https://duckdblabs.com/) and the DuckDB community (MIT).

MIT licensed, like everything it wraps.
