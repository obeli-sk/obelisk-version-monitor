// obeli-sk:version-monitor/github.run-sync-flake-lock:
//   func(repo: string) -> result<string, string>
//
// Dispatches the `sync-flake-lock.yml` GitHub Actions workflow on the repo's
// default branch via the REST API. Replaces the former `gh workflow run` exec
// activity. Throwing a string selects the `err` arm.
export default async function run_sync_flake_lock(repo) {
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
        throw "invalid repository name";
    }
    const headers = githubHeaders();

    // workflow_dispatch requires an explicit ref; use the repo's default branch,
    // which is what `gh workflow run` targeted implicitly.
    const repoResp = await fetch(`${githubApi()}/repos/obeli-sk/${encodeURIComponent(repo)}`, { headers });
    if (!repoResp.ok) {
        throw `failed to look up obeli-sk/${repo}: HTTP ${repoResp.status}`;
    }
    const ref = (await repoResp.json()).default_branch;
    if (typeof ref !== "string") {
        throw `obeli-sk/${repo} has no default branch`;
    }

    const dispatchUrl = `${githubApi()}/repos/obeli-sk/${encodeURIComponent(repo)}/actions/workflows/sync-flake-lock.yml/dispatches`;
    const resp = await fetch(dispatchUrl, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ ref }),
    });
    if (resp.status !== 204) {
        throw `failed to dispatch sync-flake-lock for obeli-sk/${repo}: HTTP ${resp.status} ${await resp.text()}`;
    }
    return `dispatched sync-flake-lock for obeli-sk/${repo} on ${ref}`;
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
