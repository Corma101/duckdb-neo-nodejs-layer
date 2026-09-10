#!/usr/bin/env bash
#
# Builds a Lambda layer zip containing @duckdb/node-api and the prebuilt Linux
# bindings for one architecture. No compilation involved: the DuckDB library
# ships as a prebuilt libduckdb.so inside the platform-specific npm package.
#
#   usage: scripts/build_layer.sh <x86_64|arm64>
#   env:   FLAVOR=base|extensions   (default: base)
#
set -euo pipefail
# shellcheck source=scripts/config.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"

ARCH="${1:-}"
assert_arch "$ARCH"
FLAVOR="${FLAVOR:-base}"
assert_flavor "$FLAVOR"

NODE_API_VERSION="$(cfg .nodeApiVersion)"
DUCKDB_VERSION="$(cfg .duckdbVersion)"
NPM_CPU="$(cfg ".architectures['$ARCH'].npmCpu")"
BINDINGS_PKG="$(cfg ".architectures['$ARCH'].bindingsPackage")"
DUCKDB_PLATFORM="$(cfg ".architectures['$ARCH'].duckdbPlatform")"

BUILD_DIR="$REPO_ROOT/build/$FLAVOR-$ARCH"
LAYER_DIR="$BUILD_DIR/nodejs"
RELEASE_DIR="$REPO_ROOT/release"
ZIP_PATH="$RELEASE_DIR/$(zip_name "$FLAVOR" "$ARCH")"

# npm needs --os/--cpu/--libc (npm >= 10.2) to install optional platform
# packages for a target other than the build host.
NPM_MAJOR="$(npm --version | cut -d. -f1)"
if [ "$NPM_MAJOR" -lt 10 ]; then
  echo "npm >= 10.2 required for cross-platform installs (found $(npm --version))" >&2
  exit 1
fi

log "building $FLAVOR layer for $ARCH"
log "@duckdb/node-api@$NODE_API_VERSION (DuckDB v$DUCKDB_VERSION), bindings: $BINDINGS_PKG"

rm -rf "$BUILD_DIR"
mkdir -p "$LAYER_DIR" "$RELEASE_DIR"

# The layer's own manifest. Lambda puts this tree at /opt/nodejs, and
# /opt/nodejs/node_modules is on NODE_PATH for every Node.js runtime.
cat > "$LAYER_DIR/package.json" <<EOF
{
  "name": "duckdb-neo-lambda-layer",
  "version": "$DUCKDB_VERSION",
  "private": true,
  "description": "DuckDB Node Neo for AWS Lambda ($ARCH, $FLAVOR flavor)",
  "dependencies": {
    "@duckdb/node-api": "$NODE_API_VERSION"
  }
}
EOF

log "installing dependencies for linux/$NPM_CPU (glibc)"
(
  cd "$LAYER_DIR"
  npm install \
    --os=linux --cpu="$NPM_CPU" --libc=glibc \
    --omit=dev --include=optional \
    --no-package-lock --no-audit --no-fund --loglevel=warn
)

BINDINGS_DIR="$LAYER_DIR/node_modules/$BINDINGS_PKG"

# Belt and braces: some npm versions still filter optional deps by the *host*
# platform. Fall back to unpacking the tarball ourselves.
if [ ! -f "$BINDINGS_DIR/libduckdb.so" ]; then
  log "npm skipped $BINDINGS_PKG, unpacking the tarball manually"
  TARBALL_DIR="$(mktemp -d)"
  trap 'rm -rf "$TARBALL_DIR"' EXIT
  (cd "$TARBALL_DIR" && npm pack "$BINDINGS_PKG@$NODE_API_VERSION" --loglevel=error >/dev/null)
  mkdir -p "$BINDINGS_DIR"
  tar -xzf "$TARBALL_DIR"/*.tgz -C "$BINDINGS_DIR" --strip-components=1
fi

# Drop bindings for every platform other than the one we target, so the layer
# stays at one libduckdb.so.
find "$LAYER_DIR/node_modules/@duckdb" -maxdepth 1 -type d -name 'node-bindings-*' \
  ! -path "$BINDINGS_DIR" -exec rm -rf {} +

if [ ! -f "$BINDINGS_DIR/libduckdb.so" ] || [ ! -f "$BINDINGS_DIR/duckdb.node" ]; then
  echo "build failed: $BINDINGS_PKG is missing libduckdb.so or duckdb.node" >&2
  exit 1
fi

INSTALLED_VERSION="$(node -p "require('$BINDINGS_DIR/package.json').version")"
if [ "$INSTALLED_VERSION" != "$NODE_API_VERSION" ]; then
  echo "build failed: expected bindings $NODE_API_VERSION, got $INSTALLED_VERSION" >&2
  exit 1
fi

# The extensions flavor bundles signed extensions so functions without egress
# (or with a read-only home) can LOAD them from /opt/duckdb/extensions.
if [ "$FLAVOR" = "extensions" ]; then
  EXT_DIR="$BUILD_DIR/duckdb/extensions/v$DUCKDB_VERSION/$DUCKDB_PLATFORM"
  mkdir -p "$EXT_DIR"
  for ext in $(cfg .bundledExtensions); do
    url="http://extensions.duckdb.org/v$DUCKDB_VERSION/$DUCKDB_PLATFORM/$ext.duckdb_extension.gz"
    log "fetching extension $ext from $url"
    curl -fsSL --retry 3 "$url" | gunzip > "$EXT_DIR/$ext.duckdb_extension"
    [ -s "$EXT_DIR/$ext.duckdb_extension" ] || { echo "empty extension: $ext" >&2; exit 1; }
  done
fi

log "zipping to $ZIP_PATH"
rm -f "$ZIP_PATH"
(
  cd "$BUILD_DIR"
  # -y keeps symlinks as symlinks, -9 because the payload is one big .so.
  zip -q -r -y -9 "$ZIP_PATH" ./*
)

ZIPPED="$(du -h "$ZIP_PATH" | cut -f1)"
UNZIPPED="$(du -sh "$BUILD_DIR" | cut -f1)"
log "done: $ZIPPED zipped, $UNZIPPED unzipped"
log "reminder: Lambda allows 50 MB per layer zip and 250 MB unzipped per function"
