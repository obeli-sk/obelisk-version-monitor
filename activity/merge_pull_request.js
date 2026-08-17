// obeli-sk:version-monitor/github.merge-pull-request:
//   func(repo: string, number: u64, head-sha: string) -> result<string, string>
//
// Merges a pull request via the REST API, requiring the head commit to still
// match `head-sha` (equivalent to `gh pr merge --match-head-commit`, which
// GitHub enforces server-side via the `sha` field). Replaces the former
// `gh pr merge` exec activity. Throwing a string selects the `err` arm.
export default async function merge_pull_request(repo, number, headSha) {
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
        throw "invalid repository name";
    }
    if (!Number.isSafeInteger(number) || number < 1) {
        throw "invalid pull request number";
    }
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
        throw "invalid head commit";
    }

    const headers = githubHeaders();
    const url = `https://api.github.com/repos/obeli-sk/${encodeURIComponent(repo)}/pulls/${number}/merge`;
    const resp = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ merge_method: "merge", sha: headSha }),
    });
    if (resp.status === 200) {
        return `https://github.com/obeli-sk/${repo}/pull/${number}`;
    }

    let detail;
    try {
        detail = (await resp.json()).message || "";
    } catch {
        detail = await resp.text();
    }
    throw `failed to merge obeli-sk/${repo}#${number}: HTTP ${resp.status} ${detail}`;
}

// The real token replaces this placeholder in the outgoing Authorization header
// via the `replace_in = ["headers"]` secret binding.
function githubHeaders() {
    const token = process.env["GH_TOKEN"];
    if (!token) {
        throw "GH_TOKEN secret is unavailable";
    }
    return {
        "accept": "application/vnd.github+json",
        "user-agent": "obelisk-version-monitor",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${token}`,
    };
}
