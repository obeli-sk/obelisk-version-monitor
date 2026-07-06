#!/usr/bin/env bash
set -euo pipefail

# Obelisk maps this process to `result<string, string>`: on exit 0 stdout is the
# `ok` arm, on non-zero exit stdout is the `err` arm. Both arms must therefore be
# a valid JSON string. Emitting nothing on failure (e.g. a repo without the
# `sync-flake-lock.yml` workflow) yields an uncategorized execution failure
# instead of a clean `err`, so every exit prints a JSON string.
json_string() {
    local s=$1
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n}
    s=${s//$'\r'/\\r}
    s=${s//$'\t'/\\t}
    printf '"%s"\n' "$s"
}

fail() {
    json_string "$1"
    exit 1
}

repo_json=$1
if [[ ! "$repo_json" =~ ^\"[A-Za-z0-9._-]+\"$ ]]; then
    fail "invalid repository name"
fi

repo=${repo_json:1:${#repo_json}-2}
if ! output=$(gh workflow run sync-flake-lock.yml --repo "obeli-sk/${repo}" 2>&1); then
    fail "failed to dispatch sync-flake-lock for obeli-sk/${repo}: ${output}"
fi

json_string "$output"
