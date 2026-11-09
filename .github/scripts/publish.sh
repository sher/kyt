#!/usr/bin/env bash
set -euo pipefail

dir="$1"
dry_run="${DRY_RUN:-false}"
name=$(node -p "require('./$dir/package.json').name")
version=$(node -p "require('./$dir/package.json').version")
tag="$name@$version"

if [ -n "$(npm view "$tag" version --registry https://registry.npmjs.org/ 2>/dev/null)" ]; then
  echo "Skip $tag: this version is already on npm."
  exit 0
fi

notes=$(mktemp)
awk -v v="$version" '$1 == "##" && $2 == v { on = 1; next } on && /^## / { exit } on { print }' "$dir/CHANGELOG.md" > "$notes"
if ! grep -q '[^[:space:]]' "$notes"; then
  echo "Error: $dir/CHANGELOG.md has no entry for $version. Add a \"## $version\" section first."
  exit 1
fi

if [ "$dry_run" = "true" ]; then
  (cd "$dir" && npm publish --dry-run)
  echo "Dry run: would create the release $tag with these notes:"
  cat "$notes"
  exit 0
fi

(cd "$dir" && npm publish --loglevel verbose)
gh release create "$tag" --target "$GITHUB_SHA" --title "$tag" --notes-file "$notes"
