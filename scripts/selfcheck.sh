#!/usr/bin/env bash
#
# selfcheck.sh - run the self-checks for the plugin's logic.
#
# Each *.selfcheck.ts in src/ is bundled with esbuild and run under Node.
#   - rule.selfcheck.ts asks c15t's REAL offline policy engine to resolve our rule
#     for several countries, so a rule the runtime rejects (`invalid-configuration`,
#     the bug that once hid the banner) fails here instead of in production.
#   - guards.selfcheck.ts covers the pure helpers: service validation, same-origin,
#     CSV escaping, layout, policy pages, language and embed URLs.
# No test framework: plain asserts.
#
# Usage:  bash scripts/selfcheck.sh      (run `npm install` first)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

if [ ! -x "$ROOT/node_modules/.bin/esbuild" ]; then
	echo "ERROR: esbuild not found. Run 'npm install' first." >&2
	exit 1
fi

for check in "$ROOT"/src/*.selfcheck.ts; do
	name="$(basename "$check" .ts)"
	"$ROOT/node_modules/.bin/esbuild" "$check" \
		--bundle --platform=node --format=esm --outfile="$OUT/$name.mjs" --log-level=warning
	node "$OUT/$name.mjs"
done
