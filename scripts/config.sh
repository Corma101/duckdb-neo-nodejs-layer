#!/usr/bin/env bash
# Shared helpers. Sourced by the other scripts; not meant to be run directly.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$REPO_ROOT/layer.config.json}"

# cfg <js-accessor> -- reads layer.config.json with node, so we don't need jq.
# Arrays come back space-separated, ready for word splitting in a for loop.
cfg() {
  node -e "
    const config = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const accessor = process.argv[2];
    const value = new Function('c', 'return c' + accessor)(config);
    if (value === undefined || value === null) {
      console.error('missing config key: ' + accessor);
      process.exit(1);
    }
    process.stdout.write(Array.isArray(value) ? value.join(' ') : String(value));
  " "$CONFIG_FILE" "$1"
}

# assert_arch <arch>
assert_arch() {
  case "${1:-}" in
    x86_64|arm64) ;;
    *) echo "usage: $(basename "$0") <x86_64|arm64>   (got: '${1:-}')" >&2; exit 64 ;;
  esac
}

# assert_flavor <flavor>
assert_flavor() {
  case "${1:-}" in
    base|extensions) ;;
    *) echo "FLAVOR must be 'base' or 'extensions' (got: '${1:-}')" >&2; exit 64 ;;
  esac
}

# layer_name <flavor> <arch>
layer_name() {
  echo "$(cfg ".flavors['$1'].layerNamePrefix")-$(cfg ".architectures['$2'].layerNameSuffix")"
}

# zip_name <flavor> <arch>
zip_name() {
  echo "duckdb-neo-layer-$1-$2.zip"
}

log() { echo "==> $*"; }
