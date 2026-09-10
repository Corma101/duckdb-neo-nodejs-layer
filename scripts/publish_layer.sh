#!/usr/bin/env bash
#
# Publishes a built layer zip to every commercial AWS region and grants public
# read access to each layer version, then records the resulting ARNs under arns/.
#
#   usage: scripts/publish_layer.sh <x86_64|arm64>
#   env:   FLAVOR=base|extensions   (default: base)
#          REGIONS="eu-west-1 us-east-1"  (default: all commercial regions, from SSM)
#          PUBLIC=false             (skip the public permission, e.g. for a dry run)
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
RUNTIMES="$(cfg .compatibleRuntimes)"
LAYER_NAME="$(layer_name "$FLAVOR" "$ARCH")"
ZIP_PATH="$REPO_ROOT/release/$(zip_name "$FLAVOR" "$ARCH")"

[ -f "$ZIP_PATH" ] || { echo "missing $ZIP_PATH -- run scripts/build_layer.sh $ARCH first" >&2; exit 1; }

DESCRIPTION="DuckDB v$DUCKDB_VERSION for Node.js via @duckdb/node-api@$NODE_API_VERSION ($ARCH)"

# Regions that never accept a public layer publish from a commercial account.
is_excluded_region() {
  case "$1" in
    *gov*|*cn-*|us-iso*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -z "${REGIONS:-}" ]; then
  log "listing commercial regions from SSM"
  REGIONS="$(aws ssm get-parameters-by-path --region us-east-1 \
    --path /aws/service/global-infrastructure/regions \
    --query 'Parameters[].Value | sort(@)' --output text)"
fi

RESULTS="$(mktemp)"
FAILED=""
trap 'rm -f "$RESULTS"' EXIT

for region in $REGIONS; do
  if is_excluded_region "$region"; then
    continue
  fi

  log "publishing $LAYER_NAME to $region"
  set +e
  # shellcheck disable=SC2086  # $RUNTIMES must word-split into several args
  LAYER_ARN="$(aws lambda publish-layer-version \
    --region "$region" \
    --layer-name "$LAYER_NAME" \
    --description "$DESCRIPTION" \
    --license-info MIT \
    --compatible-runtimes $RUNTIMES \
    --compatible-architectures "$ARCH" \
    --zip-file "fileb://$ZIP_PATH" \
    --query LayerVersionArn --output text 2>&1)"
  STATUS=$?
  set -e

  if [ $STATUS -ne 0 ]; then
    # Opt-in regions the account hasn't enabled, brand new regions, and regions
    # without the requested architecture all land here. Keep going.
    echo "    skipped $region: ${LAYER_ARN%%$'\n'*}" >&2
    FAILED="$FAILED $region"
    continue
  fi

  LAYER_VERSION="${LAYER_ARN##*:}"

  if [ "${PUBLIC:-true}" = "true" ]; then
    aws lambda add-layer-version-permission \
      --region "$region" \
      --layer-name "$LAYER_NAME" \
      --version-number "$LAYER_VERSION" \
      --statement-id "$LAYER_NAME-public" \
      --action lambda:GetLayerVersion \
      --principal '*' >/dev/null
  fi

  printf '%s\t%s\t%s\n' "$region" "$LAYER_VERSION" "$LAYER_ARN" >> "$RESULTS"
  echo "    $LAYER_ARN"
done

if [ ! -s "$RESULTS" ]; then
  echo "nothing was published -- check your AWS credentials and region list" >&2
  exit 1
fi

node "$REPO_ROOT/scripts/record_arns.mjs" \
  --layer-name "$LAYER_NAME" \
  --architecture "$ARCH" \
  --flavor "$FLAVOR" \
  --duckdb-version "$DUCKDB_VERSION" \
  --node-api-version "$NODE_API_VERSION" \
  --results "$RESULTS"

log "published to $(wc -l < "$RESULTS" | tr -d ' ') region(s)"
[ -n "$FAILED" ] && log "skipped regions:$FAILED"
exit 0
