// Dashboard for the version-monitor workflow.
//
// GET `/` serves the page; GET `/api/status` reads only the return value of the
// most recent finished `monitor.run` execution (which now owns every column) and
// maps its rows straight through, so page loads no longer crawl execution
// history. POST `/bump` schedules a batch `bump.run` over the selected repos and
// GET `/merge/:repo/:number` schedules an audited merge.
import * as obelisk from "obelisk:webhook@1.0.0";
import * as dynamic from "obelisk:webhook-dynamic@1.0.0";

const WORKFLOW_FFQN = "obeli-sk:version-monitor/monitor.run";
const BUMP_WORKFLOW_FFQN = "obeli-sk:version-monitor/bump.run";
const MERGE_FFQN = "obeli-sk:version-monitor/github.merge-pull-request";
const PR_TITLE = "Sync `flake.lock` from upstream";

export default async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname === "/bump" && request.method === "POST") {
        return await runBump(request);
    }
    if (url.pathname.startsWith("/merge/")) {
        return runMerge(request, url.pathname.substring("/merge/".length));
    }
    if (url.pathname === "/refresh") {
        return runRefresh();
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

async function fetchObelisk(urlSuffix) {
    const apiBase = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const url = `${apiBase}${urlSuffix}`;
    const token = process.env['OBELISK__API__TOKEN'];
    if (!token) {
        throw new Error("OBELISK__API__TOKEN is required");
    }
    const headers = {
        "accept": "application/json",
        authorization: `bearer ${token}`,
    };
    return await fetch(url, { headers });
}

async function collectDashboardStatus() {
    const listUrlSuffix = `/v1/executions?ffqn_prefix=${encodeURIComponent(WORKFLOW_FFQN)}&length=50`;
    const listResp = await fetchObelisk(listUrlSuffix);
    if (!listResp.ok) {
        throw new Error(`Failed to list executions: HTTP ${listResp.status}`);
    }
    const executions = await listResp.json();
    if (executions.length === 0) {
        return { message: "No workflow execution has been scheduled yet by the cron task.", rows: [] };
    }
    const finished = executions.filter(
        (e) => e.pending_state && e.pending_state.status === "finished",
    );
    if (finished.length === 0) {
        const pending = executions[0];
        return {
            message: `Workflow ${pending.execution_id} is ${pending.pending_state.status}.`,
            rows: [],
        };
    }

    const latestFinished = finished[0];
    let selected = null;
    let emptyFallback = null;
    for (const execution of finished) {
        if (execution.pending_state.result_kind !== "ok") {
            continue;
        }
        const result = await fetchExecutionResult(execution.execution_id);
        if (!("ok" in result) || !Array.isArray(result.ok)) {
            continue;
        }
        const candidate = { execution, rows: result.ok };
        if (result.ok.length > 0) {
            selected = candidate;
            break;
        }
        if (emptyFallback === null) {
            emptyFallback = candidate;
        }
    }
    if (selected === null) {
        selected = emptyFallback;
    }
    if (selected === null) {
        throw new Error("No successful monitor result is available");
    }

    const execId = selected.execution.execution_id;
    return {
        latest_run: {
            execution_id: execId,
            created_at: selected.execution.created_at || "",
        },
        stale: execId !== latestFinished.execution_id,
        latest_attempt_execution_id: latestFinished.execution_id,
        rows: selected.rows.map((row) => {
            // backcompat: monitor.run once returned a [repo, version] tuple, then
            // a record with a single `pull_request` and no `gh_action`. Tolerate
            // both older shapes during a redeploy window.
            let repo, version, pullRequests, ghAction;
            if (Array.isArray(row)) {
                repo = row[0];
                version = row[1];
                pullRequests = [];
                ghAction = null;
            } else {
                repo = row.repo;
                version = row.version;
                pullRequests = row.pull_requests
                    ?? (row.pull_request ? [row.pull_request] : []);
                ghAction = row.gh_action ?? null;
            }
            return {
                repo,
                version,
                pull_requests: pullRequests,
                gh_action: ghAction,
            };
        }),
    };
}

async function fetchExecutionResult(executionId) {
    const suffix = `/v1/executions/${encodeURIComponent(executionId)}`;
    const response = await fetchObelisk(suffix);
    if (!response.ok) {
        throw new Error(`Failed to fetch execution ${executionId}: HTTP ${response.status}`);
    }
    return await response.json();
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
    const token = process.env["GH_TOKEN"];
    if (!token) {
        throw new Error("GH_TOKEN secret is unavailable");
    }
    const headers = {
        "accept": "application/vnd.github+json",
        "user-agent": "obelisk-version-monitor",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${token}`,
    };
    return headers;
}

function runRefresh() {
    const execId = obelisk.executionIdGenerate();
    try {
        dynamic.schedule(execId, WORKFLOW_FFQN, []);
    } catch (e) {
        return errorPage(502, `Failed to schedule refresh: ${String(e)}`);
    }
    return new Response(null, {
        status: 303,
        headers: { location: "/?refreshed=1" },
    });
}

async function runBump(request) {
    let body = "";
    try {
        body = await request.text();
    } catch {
        body = "";
    }
    const repos = parseRepoList(body);
    if (repos.length === 0) {
        return errorPage(400, "No repositories selected");
    }
    for (const repo of repos) {
        if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
            return errorPage(400, "Invalid repository name");
        }
    }

    const execId = obelisk.executionIdGenerate();
    try {
        dynamic.schedule(execId, BUMP_WORKFLOW_FFQN, [repos]);
    } catch (e) {
        return errorPage(502, `Failed to schedule sync-flake-lock: ${String(e)}`);
    }

    return new Response(null, {
        status: 303,
        headers: { location: `/?bumped=${repos.length}` },
    });
}

// Parse `repo=a&repo=b` from an `application/x-www-form-urlencoded` body.
function parseRepoList(body) {
    const repos = [];
    for (const part of body.split("&")) {
        if (part === "") {
            continue;
        }
        const [rawKey, rawValue = ""] = part.split("=", 2);
        if (decodeURIComponent(rawKey) === "repo") {
            repos.push(decodeURIComponent(rawValue.replaceAll("+", " ")));
        }
    }
    return repos;
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
        dynamic.schedule(execId, MERGE_FFQN, [repo, number, requestedHead]);
    } catch (e) {
        return errorPage(502, `Failed to schedule PR merge for ${repo}: ${String(e)}`);
    }
    return new Response(null, {
        status: 303,
        headers: { location: `/?merge_submitted=${encodeURIComponent(repo)}` },
    });
}

function dashboardPage() {
    const webuiBase = process.env["WEBUI_BASE"] || "http://localhost:8080";
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
  small { color: #666; }
</style>
</head>
<body>
<h1>obeli-sk version monitor</h1>
<p><a href="/refresh">Refresh all</a> (runs the monitor workflow now)</p>
<div id="notice"></div>
<div id="meta"><p>Loading...</p></div>
<form id="bump-form" method="POST" action="/bump">
<p><button type="submit">Run sync-flake-lock on selected</button></p>
<div id="dashboard"></div>
</form>
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

const WEBUI_BASE = ${JSON.stringify(webuiBase)};

function executionLink(id) {
  return '<a href="' + WEBUI_BASE + "/execution/" + encodeURIComponent(id)
    + '" target="_blank" rel="noopener"><code>' + escapeHtml(id) + "</code></a>";
}

function renderNotice() {
  const params = new URLSearchParams(location.search);
  const bumped = params.get("bumped");
  const mergeSubmitted = params.get("merge_submitted");
  if (params.get("refreshed")) {
    notice.innerHTML = '<p class="in-progress">Scheduled a monitor refresh.</p>';
  } else if (bumped) {
    notice.innerHTML = '<p class="in-progress">Scheduled sync-flake-lock for <code>'
      + escapeHtml(bumped) + "</code> repositories.</p>";
  } else if (mergeSubmitted) {
    notice.innerHTML = '<p class="in-progress">Scheduled PR merge for <code>'
      + escapeHtml(mergeSubmitted) + "</code>.</p>";
  }
}

// Preserve the user's row selection across the 5s poll re-render.
function currentSelection() {
  const set = new Set();
  document.querySelectorAll('#dashboard input[name="repo"]:checked')
    .forEach(function(cb) { set.add(cb.value); });
  return set;
}

function toggleAll(master) {
  document.querySelectorAll('#dashboard input[name="repo"]')
    .forEach(function(cb) { cb.checked = master.checked; });
}

function renderGhAction(action) {
  if (!action) return "None";
  const className = /success|completed/.test(action.status)
    ? ""
    : /fail|error|cancel|timed_out/.test(action.status) ? "err" : "in-progress";
  const label = '<span class="' + className + '">' + escapeHtml(action.status) + "</span>";
  return action.html_url
    ? '<a target="_blank" rel="noopener" href="' + escapeHtml(action.html_url) + '">' + label + "</a>"
    : label;
}

function renderPullRequests(row) {
  const pulls = row.pull_requests || [];
  if (pulls.length === 0) return "None";
  return pulls.map(function(pull) {
    if (pull.error) return '<span class="err">' + escapeHtml(pull.error) + "</span>";
    let html = '<a target="_blank" rel="noopener" href="' + escapeHtml(pull.html_url) + '">#'
      + escapeHtml(pull.number) + "</a> " + escapeHtml(pull.state);
    if (pull.checks_state) {
      const className = pull.checks_state === "in progress"
        ? "in-progress"
        : pull.checks_state === "erroring" ? "err" : "";
      html += ' · <span class="' + className + '">checks: '
        + escapeHtml(pull.checks_state) + "</span>";
    }
    if (pull.checks_state === "passing" && pull.head_sha) {
      html += ' · <a href="/merge/'
        + encodeURIComponent(row.repo) + "/" + pull.number + "?head="
        + encodeURIComponent(pull.head_sha)
        + '">Merge</a>';
    }
    return html;
  }).join("<br>");
}

function renderStatus(status) {
  if (status.message) {
    meta.innerHTML = "<p>" + escapeHtml(status.message) + "</p>";
  } else {
    meta.innerHTML = "<p>Latest run: "
      + executionLink(status.latest_run.execution_id) + " · created <code>"
      + escapeHtml(status.latest_run.created_at) + "</code>"
      + (status.stale
        ? ' · <span class="in-progress">showing previous data; latest refresh '
          + executionLink(status.latest_attempt_execution_id) + " failed or returned no rows</span>"
        : "")
      + "</p>";
  }
  if (!status.rows || status.rows.length === 0) {
    dashboard.innerHTML = "";
    return;
  }
  const selected = currentSelection();
  const rows = status.rows.map(function(row) {
    return '<tr><td><input type="checkbox" name="repo" value="'
      + escapeHtml(row.repo) + '"' + (selected.has(row.repo) ? " checked" : "") + "></td>"
      + '<td><a target="_blank" rel="noopener" href="https://github.com/obeli-sk/' + encodeURIComponent(row.repo) + '">'
      + escapeHtml(row.repo) + "</a></td>"
      + "<td><code>" + escapeHtml(row.version) + "</code></td>"
      + "<td>" + renderGhAction(row.gh_action) + "</td>"
      + "<td>" + renderPullRequests(row) + "</td></tr>";
  }).join("");
  dashboard.innerHTML = '<table><thead><tr><th><input type="checkbox" onclick="toggleAll(this)"></th>'
    + "<th>Repository</th><th>obelisk version</th>"
    + "<th>GH Action</th><th>PRs</th></tr></thead><tbody>"
    + rows + "</tbody></table>";
}

// Navigating away (e.g. following the Merge link or submitting the bump form)
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
