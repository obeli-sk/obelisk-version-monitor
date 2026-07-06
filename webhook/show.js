// GET  / — Display the latest finished run of the version-monitor workflow.
//
// Queries the obelisk REST API for the most recent finished execution of
// `obeli-sk:version-monitor/monitor.run`, fetches its return value, and
// renders the resulting `[repo, version]` pairs as an HTML table.
const WORKFLOW_FFQN = "obeli-sk:version-monitor/monitor.run";
const BUMP_FFQN = "obeli-sk:version-monitor/github.run-sync-flake-lock";
const MERGE_FFQN = "obeli-sk:version-monitor/github.merge-pull-request";
const PR_TITLE = "Sync `flake.lock` from upstream";

export default async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/bump/")) {
        return runBump(url.pathname.substring("/bump/".length));
    }
    if (url.pathname.startsWith("/merge/")) {
        return runMerge(request, url.pathname.substring("/merge/".length));
    }
    if (url.pathname === "/api/status") {
        try {
            return jsonResponse(await collectDashboardStatus());
        } catch (e) {
            return jsonResponse({ error: String(e) }, 502);
        }
    }
    return dashboardPage();
}

async function collectDashboardStatus() {
    const apiBase = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const listUrl = `${apiBase}/v1/executions?ffqn_prefix=${encodeURIComponent(WORKFLOW_FFQN)}&length=50`;
    const listResp = await fetch(listUrl, { headers: { "accept": "application/json" } });
    if (!listResp.ok) {
        throw new Error(`Failed to list executions: HTTP ${listResp.status}`);
    }
    const executions = await listResp.json();
    if (executions.length === 0) {
        return { message: "No workflow execution has been scheduled yet by the cron task.", rows: [] };
    }
    const latestFinished = executions.find(
        (e) => e.pending_state && e.pending_state.status === "finished",
    );
    if (!latestFinished) {
        const pending = executions[0];
        return {
            message: `Workflow ${pending.execution_id} is ${pending.pending_state.status}.`,
            rows: [],
        };
    }

    const execId = latestFinished.execution_id;
    const retUrl = `${apiBase}/v1/executions/${encodeURIComponent(execId)}`;
    const retResp = await fetch(retUrl, { headers: { "accept": "application/json" } });
    if (!retResp.ok) {
        throw new Error(`Failed to fetch execution ${execId}: HTTP ${retResp.status}`);
    }
    const retVal = await retResp.json();
    if (!("ok" in retVal)) {
        throw new Error("err" in retVal
            ? `Workflow failed: ${String(retVal.err)}`
            : `Execution error: ${JSON.stringify(retVal.execution_error)}`);
    }

    const pairs = retVal.ok || [];
    const [executionByRepo, mergeByRepo, prByRepo] = await Promise.all([
        fetchBumpExecutions(apiBase),
        fetchLatestExecutionsByRepo(apiBase, MERGE_FFQN),
        fetchPullRequests(pairs.map(([repo]) => repo)),
    ]);
    return {
        latest_run: {
            execution_id: execId,
            created_at: latestFinished.created_at || "",
        },
        rows: pairs.map(([repo, version]) => ({
            repo,
            version,
            action_execution: executionForJson(executionByRepo.get(repo)),
            pull_request: pullRequestForJson(prByRepo.get(repo)),
            merge_execution: executionForJson(mergeByRepo.get(repo)),
        })),
    };
}

async function fetchBumpExecutions(apiBase) {
    const listUrl = `${apiBase}/v1/executions?ffqn_prefix=${encodeURIComponent(BUMP_FFQN)}&show_derived=true&length=100`;
    const resp = await fetch(listUrl, { headers: { "accept": "application/json" } });
    if (!resp.ok) {
        console.warn("Failed to list bump executions:", resp.status);
        return new Map();
    }

    const executions = await resp.json();
    const entries = await Promise.all(executions.map(async (execution) => {
        const eventsUrl = `${apiBase}/v1/executions/${encodeURIComponent(execution.execution_id)}/events?version=0&including_cursor=true&length=1`;
        const eventsResp = await fetch(eventsUrl, { headers: { "accept": "application/json" } });
        if (!eventsResp.ok) {
            return null;
        }
        const payload = await eventsResp.json();
        const repo = payload.events?.[0]?.event?.created?.params?.[0];
        return typeof repo === "string" ? [repo, execution] : null;
    }));

    const byRepo = new Map();
    for (const entry of entries) {
        if (entry !== null && !byRepo.has(entry[0])) {
            byRepo.set(entry[0], entry[1]);
        }
    }

    await Promise.all(Array.from(byRepo.values()).map(async (execution) => {
        if (execution.pending_state?.status !== "finished"
            || execution.pending_state?.result_kind !== "ok") {
            return;
        }
        const resultUrl = `${apiBase}/v1/executions/${encodeURIComponent(execution.execution_id)}`;
        const resultResp = await fetch(resultUrl, { headers: { "accept": "application/json" } });
        if (!resultResp.ok) {
            return;
        }
        const result = await resultResp.json();
        if (typeof result.ok === "string"
            && /^https:\/\/github\.com\/obeli-sk\/[A-Za-z0-9._-]+\/actions\/runs\/[0-9]+$/.test(result.ok)) {
            execution.run_url = result.ok;
            await fetchGitHubRun(execution);
        }
    }));
    return byRepo;
}

async function fetchLatestExecutionsByRepo(apiBase, ffqn) {
    const listUrl = `${apiBase}/v1/executions?ffqn_prefix=${encodeURIComponent(ffqn)}&show_derived=true&length=100`;
    const resp = await fetch(listUrl, { headers: { "accept": "application/json" } });
    if (!resp.ok) {
        console.warn("Failed to list executions:", ffqn, resp.status);
        return new Map();
    }

    const executions = await resp.json();
    const entries = await Promise.all(executions.map(async (execution) => {
        const eventsUrl = `${apiBase}/v1/executions/${encodeURIComponent(execution.execution_id)}/events?version=0&including_cursor=true&length=1`;
        const eventsResp = await fetch(eventsUrl, { headers: { "accept": "application/json" } });
        if (!eventsResp.ok) {
            return null;
        }
        const payload = await eventsResp.json();
        const repo = payload.events?.[0]?.event?.created?.params?.[0];
        return typeof repo === "string" ? [repo, execution] : null;
    }));

    const byRepo = new Map();
    for (const entry of entries) {
        if (entry !== null && !byRepo.has(entry[0])) {
            byRepo.set(entry[0], entry[1]);
        }
    }
    return byRepo;
}

async function fetchGitHubRun(execution) {
    const match = execution.run_url.match(
        /^https:\/\/github\.com\/obeli-sk\/([A-Za-z0-9._-]+)\/actions\/runs\/([0-9]+)$/,
    );
    if (!match) {
        return;
    }

    const headers = githubHeaders();
    const url = `https://api.github.com/repos/obeli-sk/${encodeURIComponent(match[1])}/actions/runs/${match[2]}`;
    try {
        const resp = await fetch(url, { headers });
        if (!resp.ok) {
            console.warn("Failed to fetch GitHub run:", resp.status);
            return;
        }
        const run = await resp.json();
        execution.github_run = {
            status: run.status,
            conclusion: run.conclusion,
        };
    } catch (e) {
        console.warn("Failed to fetch GitHub run:", String(e));
    }
}

async function fetchPullRequests(repos) {
    const headers = githubHeaders();

    const byRepo = new Map(repos.map((repo) => [repo, null]));
    const query = `org:obeli-sk is:pr in:title "${PR_TITLE}"`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=100&sort=created&order=desc`;
    try {
        const resp = await fetch(url, { headers });
        if (!resp.ok) {
            console.warn("Failed to search PRs:", resp.status);
            return new Map(repos.map((repo) => [repo, { error: `HTTP ${resp.status}` }]));
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
    } catch (e) {
        console.warn("Failed to search PRs:", String(e));
        return new Map(repos.map((repo) => [repo, { error: String(e) }]));
    }
    return byRepo;
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

function executionForJson(execution) {
    if (!execution) {
        return null;
    }
    const state = execution.pending_state || {};
    const status = state.status || "unknown";
    return {
        execution_id: execution.execution_id,
        status,
        result: status === "finished" ? formatResultKind(state.result_kind) : null,
        run_url: execution.run_url || null,
        github_run: execution.github_run || null,
    };
}

function pullRequestForJson(pull) {
    if (pull === undefined) {
        return { error: "Unknown" };
    }
    if (pull === null) {
        return null;
    }
    if (pull.error) {
        return { error: pull.error };
    }
    return {
        number: pull.number,
        html_url: pull.html_url,
        state: pull.merged_at || pull.pull_request?.merged_at ? "merged" : pull.state,
        checks_state: pull.checks_state || null,
        head_sha: pull.head_sha || null,
    };
}

function formatResultKind(resultKind) {
    if (typeof resultKind === "string") {
        return resultKind;
    }
    if (resultKind?.err?.execution_failure) {
        return `error: ${String(resultKind.err.execution_failure).replaceAll("_", " ")}`;
    }
    return resultKind ? JSON.stringify(resultKind) : "unknown";
}

function runBump(encodedRepo) {
    let repo;
    try {
        repo = decodeURIComponent(encodedRepo);
    } catch {
        return errorPage(400, "Invalid repository name");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
        return errorPage(400, "Invalid repository name");
    }

    const execId = obelisk.executionIdGenerate();
    try {
        obelisk.schedule(execId, BUMP_FFQN, [repo]);
    } catch (e) {
        return errorPage(502, `Failed to schedule sync-flake-lock for ${repo}: ${String(e)}`);
    }

    return new Response(null, {
        status: 303,
        headers: { location: `/?submitted=${encodeURIComponent(repo)}` },
    });
}

async function runMerge(request, path) {
    const parts = path.split("/");
    if (parts.length !== 2) {
        return errorPage(400, "Invalid merge request");
    }

    let repo;
    try {
        repo = decodeURIComponent(parts[0]);
    } catch {
        return errorPage(400, "Invalid repository name");
    }
    const number = Number(parts[1]);
    const requestedHead = getQueryParam(request.url, "head");
    if (!/^[A-Za-z0-9._-]+$/.test(repo)
        || !Number.isSafeInteger(number)
        || number < 1
        || !/^[0-9a-f]{40}$/.test(requestedHead || "")) {
        return errorPage(400, "Invalid merge request");
    }

    const headers = githubHeaders();
    const pullUrl = `https://api.github.com/repos/obeli-sk/${encodeURIComponent(repo)}/pulls/${number}`;
    const pullResp = await fetch(pullUrl, { headers });
    if (!pullResp.ok) {
        return errorPage(502, `Failed to fetch PR: HTTP ${pullResp.status}`);
    }
    const pull = await pullResp.json();
    if (pull.state !== "open" || pull.title !== PR_TITLE || pull.head?.sha !== requestedHead) {
        return errorPage(409, "PR is no longer an open, unchanged sync-flake-lock PR");
    }

    const checksUrl = `https://api.github.com/repos/obeli-sk/${encodeURIComponent(repo)}/commits/${requestedHead}/check-runs?per_page=100`;
    const checksResp = await fetch(checksUrl, { headers });
    if (!checksResp.ok) {
        return errorPage(502, `Failed to fetch PR checks: HTTP ${checksResp.status}`);
    }
    const checks = await checksResp.json();
    if (classifyChecks(checks.check_runs || []) !== "passing") {
        return errorPage(409, "PR checks are not passing");
    }

    const execId = obelisk.executionIdGenerate();
    try {
        obelisk.schedule(execId, MERGE_FFQN, [repo, number, requestedHead]);
    } catch (e) {
        return errorPage(502, `Failed to schedule PR merge for ${repo}: ${String(e)}`);
    }
    return new Response(null, {
        status: 303,
        headers: { location: `/?merge_submitted=${encodeURIComponent(repo)}` },
    });
}

function dashboardPage() {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>obeli-sk version monitor</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 2em auto; padding: 0 1em; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 0.4em 0.8em; text-align: left; }
  th { background: #f4f4f4; }
  code { font-size: 0.95em; }
  .err { color: #b00; }
  .in-progress { color: #965c00; font-weight: 600; }
  .inline { display: inline; }
  small { color: #666; }
</style>
</head>
<body>
<h1>obeli-sk version monitor</h1>
<div id="notice"></div>
<div id="meta"><p>Loading...</p></div>
<div id="dashboard"></div>
<script>
const notice = document.getElementById("notice");
const meta = document.getElementById("meta");
const dashboard = document.getElementById("dashboard");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const WEBUI_BASE = "http://localhost:8080";

function executionLink(id) {
  return '<a href="' + WEBUI_BASE + "/execution/" + encodeURIComponent(id)
    + '" target="_blank" rel="noopener"><code>' + escapeHtml(id) + "</code></a>";
}

function renderNotice() {
  const params = new URLSearchParams(location.search);
  const submitted = params.get("submitted");
  const mergeSubmitted = params.get("merge_submitted");
  if (submitted) {
    notice.innerHTML = '<p class="in-progress">Scheduled sync-flake-lock for <code>'
      + escapeHtml(submitted) + "</code>.</p>";
  } else if (mergeSubmitted) {
    notice.innerHTML = '<p class="in-progress">Scheduled PR merge for <code>'
      + escapeHtml(mergeSubmitted) + "</code>.</p>";
  }
}

function renderExecution(execution) {
  if (!execution) return "Not run";
  let label = execution.status === "finished"
    ? "finished: " + (execution.result || "unknown")
    : execution.status.replaceAll("_", " ");
  let className = execution.status === "finished" ? "" : ' class="in-progress"';
  if (execution.github_run && execution.github_run.status) {
    if (execution.github_run.status === "completed") {
      label = "GH: completed: " + (execution.github_run.conclusion || "unknown");
      className = "";
    } else {
      label = "GH: " + execution.github_run.status.replaceAll("_", " ");
      className = ' class="in-progress"';
    }
  }
  const status = execution.run_url
    ? "<a" + className + ' target="_blank" rel="noopener" href="' + escapeHtml(execution.run_url) + '">' + escapeHtml(label) + "</a>"
    : "<span" + className + ">" + escapeHtml(label) + "</span>";
  return status + "<br><small>" + executionLink(execution.execution_id) + "</small>";
}

function renderMergeExecution(execution) {
  if (!execution) return "";
  const label = execution.status === "finished"
    ? execution.result || "unknown"
    : execution.status.replaceAll("_", " ");
  const className = execution.status === "finished" ? "" : ' class="in-progress"';
  return '<br>merge <span' + className + ">" + escapeHtml(label)
    + "</span><br><small>" + executionLink(execution.execution_id) + "</small>";
}

function renderPullRequest(row) {
  const pull = row.pull_request;
  if (pull === null) return "Not found";
  if (pull.error) return '<span class="err">' + escapeHtml(pull.error) + "</span>";
  let html = '<a target="_blank" rel="noopener" href="' + escapeHtml(pull.html_url) + '">#'
    + escapeHtml(pull.number) + "</a> " + escapeHtml(pull.state);
  if (pull.state === "open" && pull.checks_state) {
    const className = pull.checks_state === "in progress"
      ? "in-progress"
      : pull.checks_state === "erroring" ? "err" : "";
    html += ' · <span class="' + className + '">checks: '
      + escapeHtml(pull.checks_state) + "</span>";
  }
  if (pull.state === "open" && pull.checks_state === "passing" && pull.head_sha) {
    html += ' · <form class="inline" method="post" action="/merge/'
      + encodeURIComponent(row.repo) + "/" + pull.number + "?head="
      + encodeURIComponent(pull.head_sha)
      + '"><button type="submit">Merge</button></form>';
  }
  return html + renderMergeExecution(row.merge_execution);
}

function renderStatus(status) {
  if (status.message) {
    meta.innerHTML = "<p>" + escapeHtml(status.message) + "</p>";
  } else {
    meta.innerHTML = "<p>Latest run: "
      + executionLink(status.latest_run.execution_id) + " · created <code>"
      + escapeHtml(status.latest_run.created_at) + "</code></p>";
  }
  if (!status.rows || status.rows.length === 0) {
    dashboard.innerHTML = "";
    return;
  }
  const rows = status.rows.map(function(row) {
    return '<tr><td><a target="_blank" rel="noopener" href="https://github.com/obeli-sk/' + encodeURIComponent(row.repo) + '">'
      + escapeHtml(row.repo) + "</a></td><td><code>" + escapeHtml(row.version)
      + '</code></td><td><a href="/bump/' + encodeURIComponent(row.repo)
      + '">Run sync-flake-lock</a></td><td>' + renderExecution(row.action_execution)
      + "</td><td>" + renderPullRequest(row) + "</td></tr>";
  }).join("");
  dashboard.innerHTML = "<table><thead><tr><th>Repository</th><th>obelisk version</th>"
    + "<th>Action</th><th>GH Action</th><th>PR</th></tr></thead><tbody>"
    + rows + "</tbody></table>";
}

// Navigating away (e.g. submitting the Merge form or following the bump link)
// aborts the in-flight /api/status fetch, which would otherwise flash a bogus
// "Failed to refresh" error before the next page loads.
let navigatingAway = false;
addEventListener("pagehide", function() { navigatingAway = true; });
addEventListener("beforeunload", function() { navigatingAway = true; });

async function refresh() {
  try {
    const response = await fetch("/api/status", { headers: { accept: "application/json" } });
    const status = await response.json();
    if (!response.ok || status.error) throw new Error(status.error || "HTTP " + response.status);
    renderStatus(status);
  } catch (error) {
    if (navigatingAway) return;
    meta.innerHTML = '<p class="err">Failed to refresh: ' + escapeHtml(error) + "</p>";
  }
}

renderNotice();
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
    return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
    });
}

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

function errorPage(status, msg) {
    return new Response(`<!doctype html><h1>Error ${status}</h1><p>${escapeHtml(msg)}</p>`, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
    });
}

function getQueryParam(requestUrl, name) {
    const queryStart = requestUrl.indexOf("?");
    if (queryStart === -1) {
        return null;
    }
    for (const part of requestUrl.substring(queryStart + 1).split("&")) {
        const [rawKey, rawValue = ""] = part.split("=", 2);
        if (decodeURIComponent(rawKey) === name) {
            return decodeURIComponent(rawValue.replaceAll("+", " "));
        }
    }
    return null;
}

function escapeHtml(s) {
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
