// obeli-sk:version-monitor/repos.fetch-pull-requests:
//   func(repos: list<string>) -> result<string, string>
//
// Precomputes the sync-flake-lock pull-request state for each repo so the
// dashboard webhook can read it from the execution log instead of calling the
// GitHub API on every page load (an org-wide PR search plus a per-PR check-runs
// lookup, which dominated the dashboard's load time). Returns a JSON object
// mapping each requested repo to { number, html_url, state, checks_state,
// head_sha }, or null when no matching PR exists. Throws (err/retry) on a hard
// GitHub search failure.
const PR_TITLE = "Sync `flake.lock` from upstream";

export default async function fetch_pull_requests(repos) {
    const headers = githubHeaders();
    const byRepo = new Map(repos.map((repo) => [repo, null]));
    const query = `org:obeli-sk is:pr in:title "${PR_TITLE}"`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=100&sort=created&order=desc`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
        throw `GitHub PR search failed: HTTP ${resp.status}`;
    }
    const payload = await resp.json();
    for (const pull of payload.items || []) {
        if (pull.title !== PR_TITLE) {
            continue;
        }
        const repo = pull.repository_url?.split("/").pop();
        if (byRepo.has(repo) && byRepo.get(repo) === null) {
            byRepo.set(repo, pull);
        }
    }

    await Promise.all(Array.from(byRepo.entries()).map(async ([repo, pull]) => {
        if (pull?.state === "open") {
            await fetchPullRequestChecks(repo, pull, headers);
        }
    }));

    const out = {};
    for (const [repo, pull] of byRepo.entries()) {
        out[repo] = pullRequestForJson(pull);
    }
    return JSON.stringify(out);
}

async function fetchPullRequestChecks(repo, pull, headers) {
    try {
        const pullUrl = `https://api.github.com/repos/obeli-sk/${encodeURIComponent(repo)}/pulls/${pull.number}`;
        const pullResp = await fetch(pullUrl, { headers });
        if (!pullResp.ok) {
            console.warn("Failed to fetch PR:", repo, pull.number, pullResp.status);
            return;
        }
        const details = await pullResp.json();
        const sha = details.head?.sha;
        if (typeof sha !== "string") {
            return;
        }
        pull.head_sha = sha;

        const checksUrl = `https://api.github.com/repos/obeli-sk/${encodeURIComponent(repo)}/commits/${sha}/check-runs?per_page=100`;
        const checksResp = await fetch(checksUrl, { headers });
        if (!checksResp.ok) {
            console.warn("Failed to fetch PR checks:", repo, pull.number, checksResp.status);
            return;
        }
        const payload = await checksResp.json();
        pull.checks_state = classifyChecks(payload.check_runs || []);
    } catch (e) {
        console.warn("Failed to fetch PR checks:", repo, pull.number, String(e));
    }
}

function classifyChecks(checks) {
    if (checks.some((check) => check.status !== "completed")) {
        return "in progress";
    }
    if (checks.length === 0) {
        return "in progress";
    }
    const passing = new Set(["success", "neutral", "skipped"]);
    return checks.every((check) => passing.has(check.conclusion)) ? "passing" : "erroring";
}

function pullRequestForJson(pull) {
    if (pull === null) {
        return null;
    }
    return {
        number: pull.number,
        html_url: pull.html_url,
        state: pull.merged_at || pull.pull_request?.merged_at ? "merged" : pull.state,
        checks_state: pull.checks_state || null,
        head_sha: pull.head_sha || null,
    };
}

// The real token is injected into the outgoing Authorization header by the
// `replace_in = ["headers"]` secret binding; `process.env` only carries a
// per-run placeholder.
function githubHeaders() {
    const headers = {
        "accept": "application/vnd.github+json",
        "user-agent": "obelisk-version-monitor",
        "x-github-api-version": "2022-11-28",
    };
    const token = process.env["GH_TOKEN"];
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }
    return headers;
}
