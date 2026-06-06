#!/usr/bin/env bash
set -euo pipefail

repo_json=$1
if [[ ! "$repo_json" =~ ^\"[A-Za-z0-9._-]+\"$ ]]; then
    echo "invalid repository name" >&2
    exit 1
fi

repo=${repo_json:1:${#repo_json}-2}
run_url=$(gh workflow run sync-flake-lock.yml --repo "obeli-sk/${repo}")
printf '"%s"\n' "$run_url"
