#!/usr/bin/env bash
set -euo pipefail

repo_json=$1
number_json=$2
head_sha_json=$3

if [[ ! "$repo_json" =~ ^\"[A-Za-z0-9._-]+\"$ ]]; then
    echo "invalid repository name" >&2
    exit 1
fi
if [[ ! "$number_json" =~ ^[1-9][0-9]*$ ]]; then
    echo "invalid pull request number" >&2
    exit 1
fi
if [[ ! "$head_sha_json" =~ ^\"[0-9a-f]{40}\"$ ]]; then
    echo "invalid head commit" >&2
    exit 1
fi

repo=${repo_json:1:${#repo_json}-2}
head_sha=${head_sha_json:1:${#head_sha_json}-2}
gh pr merge "$number_json" \
    --repo "obeli-sk/${repo}" \
    --merge \
    --match-head-commit "$head_sha"
printf '"https://github.com/obeli-sk/%s/pull/%s"\n' "$repo" "$number_json"
