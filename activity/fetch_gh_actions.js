// obeli-sk:version-monitor/github.fetch-gh-actions:
//   func(repos: list<string>) -> result<string, string>
//
// Resolves the latest `sync-flake-lock.yml` GitHub Actions run for each repo so
// the monitor result owns the dashboard's GH-action column. `workflow_dispatch`
// returns 204 with no run id and GitHub's runs list is eventually consistent,
// so only the monitor (polling on its own cadence) can reliably read the latest
// run. Returns a JSON object mapping each repo to { html_url, status }, or null
// when the workflow has never run (or the repo has no such workflow).
export default async function fetch_gh_actions(repos) {
    const headers = githubHeaders();
    const entries = await Promise.all(repos.map(async (repo) => {
        return [repo, await fetchLatestSyncRun(repo, headers)];
    }));
    const out = {};
    for (const [repo, run] of entries) {
        out[repo] = run;
    }
    return JSON.stringify(out);
}

async function fetchLatestSyncRun(repo, headers) {
    try {
        const url = `https://api.github.com/repos/obeli-sk/${encodeURIComponent(repo)}/actions/workflows/sync-flake-lock.yml/runs?per_page=1`;
        const resp = await fetch(url, { headers });
        if (resp.status === 404) {
            return null;
        }
        if (!resp.ok) {
            console.warn("Failed to fetch actions runs:", repo, resp.status);
            return null;
        }
        const run = ((await resp.json()).workflow_runs || [])[0];
        if (!run) {
            return null;
        }
        const status = run.status === "completed" ? (run.conclusion || "completed") : run.status;
        return { html_url: run.html_url, status };
    } catch (e) {
        console.warn("Failed to fetch actions runs:", repo, String(e));
        return null;
    }
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
