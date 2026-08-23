// obeli-sk:version-monitor/repos.fetch-pull-requests:
//   func(repos: list<string>) -> result<string, string>
//
// Precomputes the open sync-flake-lock pull requests for each repo so the
// dashboard webhook can read them from the execution log instead of calling the
// GitHub API on every page load (an org-wide PR search plus a per-PR check-runs
// lookup, which dominated the dashboard's load time). Returns a JSON object
// mapping each requested repo to a list of { number, html_url, state,
// checks_state, head_sha } (empty when none). Throws (err/retry) on a hard
// GitHub search failure.
const PR_TITLE = "Sync `flake.lock` from upstream";

export default async function fetch_pull_requests(repos) {
    const headers = githubHeaders();
    const byRepo = new Map(repos.map((repo) => [repo, []]));
    const query = `org:obeli-sk is:pr is:open in:title "${PR_TITLE}"`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=100&sort=created&order=desc`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
        throw `GitHub PR search failed: HTTP ${resp.status}`;
    }
    const payload = await resp.json();
    const pulls = [];
    for (const pull of payload.items || []) {
        if (pull.title !== PR_TITLE) {
            continue;
        }
        const repo = pull.repository_url?.split("/").pop();
        if (byRepo.has(repo)) {
            byRepo.get(repo).push(pull);
            pulls.push([repo, pull]);
        }
    }

    await Promise.all(pulls.map(([repo, pull]) => fetchPullRequestChecks(repo, pull, headers)));

    const out = {};
    for (const [repo, list] of byRepo.entries()) {
        out[repo] = list.map(pullRequestForJson);
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
    return {
        number: pull.number,
        html_url: pull.html_url,
        state: pull.state,
        checks_state: pull.checks_state || null,
        head_sha: pull.head_sha || null,
    };
}

// The real token is injected into the outgoing Authorization header by the
// `replace_in = ["headers"]` secret binding; `process.env` only carries a
// per-run placeholder.
function githubHeaders() {
    const token = process.env["GH_TOKEN"];
    if (!token) {
        throw "GH_TOKEN secret is unavailable";
    }
    const headers = {
        "accept": "application/vnd.github+json",
        "user-agent": "obelisk-version-monitor",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${token}`,
    };
    return headers;
}
