#!/bin/sh
# Run by Xcode's "Bundle extension scripts" build phases. Builds the extension's
# TypeScript and copies the generated scripts into the bundle being built.
#
#   xcode-bundle.sh extension   build everything, copy the extension's scripts
#   xcode-bundle.sh app         copy the host app's Script.js (built by the
#                               extension target, which the app depends on)
#
# The scripts are generated, not checked in, and live outside the Xcode
# project: its folders are synchronised, so anything in them is copied into the
# bundle under its bare name, and generated files beside the sources would
# collide with them.

set -eu

kind="${1:?usage: xcode-bundle.sh extension|app}"
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
destination="${TARGET_BUILD_DIR:?run from an Xcode build phase}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?run from an Xcode build phase}"

# Xcode runs build phases with a minimal PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/Library/pnpm:${HOME}/.local/share/pnpm:${PATH}"

cd "$package_dir"

build() {
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "error: pnpm is required to build the extension's scripts. Install it (https://pnpm.io/installation), then build again." >&2
    exit 1
  fi

  # One install for the whole workspace, at the repository root.
  [ -d node_modules ] || (cd .. && pnpm install --frozen-lockfile)
  pnpm build
}

mkdir -p "$destination"

case "$kind" in
  extension)
    build
    cp dist/extension/*.js "$destination/"
    ;;
  app)
    [ -f dist/app/Script.js ] || build
    cp dist/app/Script.js "$destination/"
    ;;
  *)
    echo "error: unknown bundle kind '$kind'" >&2
    exit 1
    ;;
esac
