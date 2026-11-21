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
    const url = `${githubApi()}/repos/obeli-sk/${encodeURIComponent(repo)}/pulls/${number}/merge`;
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

// In the cloud GITHUB_API_URL is the GitHub integration proxy, which authenticates requests itself.
function githubApi() {
    return process.env["GITHUB_API_URL"].replace(/\/+$/, "");
}

function githubHeaders() {
    const headers = {
        "accept": "application/vnd.github+json",
        "user-agent": "obelisk-version-monitor",
        "x-github-api-version": "2022-11-28",
    };
    const token = process.env["MONITOR_GITHUB_TOKEN"];
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }
    return headers;
}
