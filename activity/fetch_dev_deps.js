// obeli-sk:version-monitor/repos.fetch-dev-deps:
//   func(repo: string) -> result<string, variant {
//       permanent-not-found,
//       transient-error(string),
//       execution-failed,
//   }>
//
// Fetches `dev-deps.txt` from the default branch of `obeli-sk/<repo>` via the
// GitHub Contents API. The variant err arm distinguishes:
//   - permanent-not-found      → file does not exist on the default branch.
//                                Contains "permanent" in its name, so obelisk
//                                won't retry.
//   - transient-error(string)  → network/5xx/etc., obelisk will retry. The
//                                payload carries a diagnostic message.
//   - execution-failed         → reserved by obelisk for trap/timeout escalation.
//
// Throwing a snake_case string selects a no-payload variant case; throwing
// `{ case_name: payload }` selects a case with payload.
export default async function fetch_dev_deps(repo) {
    const headers = { ...githubHeaders(), accept: "application/vnd.github.raw+json" };
    const url = `${githubApi()}/repos/obeli-sk/${encodeURIComponent(repo)}/contents/dev-deps.txt`;
    console.info("Fetching", url);
    const resp = await fetch(url, { headers });
    if (resp.ok) {
        return await resp.text();
    }
    if (resp.status === 404) {
        console.info("dev-deps.txt not found for", repo);
        throw "permanent_not_found";
    }
    const msg = `HTTP ${resp.status} fetching ${url}`;
    console.warn(msg);
    throw { transient_error: msg };
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
