#!/usr/bin/env bash
#
# Unzips a built layer and runs test/smoke.mjs inside an AWS Lambda base image,
# with the layer mounted at /opt and no network access.
#
#   usage: scripts/smoke_test.sh <x86_64|arm64>
#   env:   FLAVOR=base|extensions      (default: base)
#          RUNTIME_IMAGE=public.ecr.aws/lambda/nodejs:22
#
set -euo pipefail
# shellcheck source=scripts/config.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"

ARCH="${1:-}"
assert_arch "$ARCH"
FLAVOR="${FLAVOR:-base}"
assert_flavor "$FLAVOR"

RUNTIME_IMAGE="${RUNTIME_IMAGE:-public.ecr.aws/lambda/nodejs:22}"
DOCKER_PLATFORM="$(cfg ".architectures['$ARCH'].dockerPlatform")"
DUCKDB_VERSION="$(cfg .duckdbVersion)"
BUNDLED_EXTENSIONS="$(cfg .bundledExtensions)"
ZIP_PATH="$REPO_ROOT/release/$(zip_name "$FLAVOR" "$ARCH")"
OPT_DIR="$REPO_ROOT/build/smoke-$FLAVOR-$ARCH"

[ -f "$ZIP_PATH" ] || { echo "missing $ZIP_PATH -- run scripts/build_layer.sh $ARCH first" >&2; exit 1; }

log "unzipping $(basename "$ZIP_PATH") to a mock /opt"
rm -rf "$OPT_DIR"
mkdir -p "$OPT_DIR"
unzip -q "$ZIP_PATH" -d "$OPT_DIR"

log "running test/smoke.mjs in $RUNTIME_IMAGE ($DOCKER_PLATFORM, no network)"
docker run --rm \
  --platform "$DOCKER_PLATFORM" \
  --network none \
  --entrypoint /var/lang/bin/node \
  -v "$OPT_DIR:/opt:ro" \
  -v "$REPO_ROOT/test:/test:ro" \
  -e NODE_PATH=/opt/nodejs/node_modules \
  -e FLAVOR="$FLAVOR" \
  -e EXPECTED_DUCKDB_VERSION="$DUCKDB_VERSION" \
  -e BUNDLED_EXTENSIONS="$BUNDLED_EXTENSIONS" \
  "$RUNTIME_IMAGE" /test/smoke.mjs
