#!/usr/bin/env bash
# Build the Runar compiler and SDK from source. There is no Runar 1.0 release
# on npm yet, so this project links against a checkout of icellan/runar main,
# pinned to the commit the contracts were developed and tested against.
set -euo pipefail

RUNAR_REPO="${RUNAR_REPO:-https://github.com/icellan/runar}"
RUNAR_COMMIT="${RUNAR_COMMIT:-36b88b83012438d67b13386b5cdbef8b9c5216f2}"

cd "$(dirname "$0")/.."
mkdir -p vendor
if [ ! -d vendor/runar/.git ]; then
  git clone "$RUNAR_REPO" vendor/runar
fi
git -C vendor/runar fetch origin main
git -C vendor/runar checkout --quiet "$RUNAR_COMMIT"

(cd vendor/runar && pnpm install && pnpm run build)
pnpm install
echo "Runar built at $(git -C vendor/runar rev-parse --short HEAD)"
