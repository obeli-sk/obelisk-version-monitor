#!/usr/bin/env bash
set -euo pipefail

# Obelisk maps this process to `result<string, string>`: on exit 0 stdout is the
# `ok` arm, on non-zero exit stdout is the `err` arm. Both arms must therefore be
# a valid JSON string, so every exit prints a JSON string (an empty stdout on a
# non-zero exit becomes an uncategorized execution failure instead of `err`).
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
number_json=$2
head_sha_json=$3

if [[ ! "$repo_json" =~ ^\"[A-Za-z0-9._-]+\"$ ]]; then
    fail "invalid repository name"
fi
if [[ ! "$number_json" =~ ^[1-9][0-9]*$ ]]; then
    fail "invalid pull request number"
fi
if [[ ! "$head_sha_json" =~ ^\"[0-9a-f]{40}\"$ ]]; then
    fail "invalid head commit"
fi

repo=${repo_json:1:${#repo_json}-2}
head_sha=${head_sha_json:1:${#head_sha_json}-2}
if ! output=$(gh pr merge "$number_json" \
    --repo "obeli-sk/${repo}" \
    --merge \
    --match-head-commit "$head_sha" 2>&1); then
    fail "failed to merge obeli-sk/${repo}#${number_json}: ${output}"
fi

json_string "https://github.com/obeli-sk/${repo}/pull/${number_json}"
